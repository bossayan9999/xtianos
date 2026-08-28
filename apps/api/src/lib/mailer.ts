import net from "node:net";
import tls from "node:tls";
import os from "node:os";

import { env } from "./env";

export function smtpConfigured(): boolean {
  return env.smtpHost !== "";
}

class SmtpSession {
  private sock: net.Socket = null as unknown as net.Socket;
  private buffer = "";
  private lineParts: string[] = [];
  private pending: { resolve: (r: { code: number; lines: string[] }) => void; reject: (e: Error) => void } | null = null;
  private err: Error | null = null;

  private onData = (chunk: Buffer): void => {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const code = Number.parseInt(raw.slice(0, 3), 10);
      if (Number.isNaN(code)) continue;
      const cont = raw.length > 3 && raw[3] === "-";
      const line = raw.slice(4);
      if (cont) {
        this.lineParts.push(line);
        continue;
      }
      const lines = this.lineParts.concat([line]);
      this.lineParts = [];
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.resolve({ code, lines });
      }
    }
  };

  private attach(socket: net.Socket): void {
    this.sock = socket;
    socket.on("data", this.onData);
    socket.on("error", (err) => {
      this.err = err;
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.reject(err);
      }
    });
  }

  /** Wait for the next complete reply without sending anything (e.g. greeting). */
  private readReply(): Promise<{ code: number; lines: string[] }> {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  /** Send one command and resolve with the complete reply (incl. multiline). */
  private cmd(line: string): Promise<{ code: number; lines: string[] }> {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending) {
          this.pending = null;
          reject(new Error("SMTP reply timeout"));
        }
      }, 20_000);
      this.pending = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.sock.write(line + "\r\n", "utf8");
    });
  }

  /** Upgrade to TLS in-place (after STARTTLS 220). */
  private async upgradeTls(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const secure = tls.connect({ socket: this.sock, rejectUnauthorized: false });
      secure.on("data", this.onData);
      this.sock = secure;
      secure.once("secureConnect", () => resolve());
      secure.once("error", (err) => {
        this.err = err;
        reject(err);
      });
    });
  }

  async send(opts: { to: string; subject: string; text: string }): Promise<void> {
    const fromMatch = /<([^>]+)>/.exec(env.smtpFrom);
    const fromAddr = fromMatch ? fromMatch[1] : env.smtpFrom;
    const encodedSubject = /^[\x00-\x7f]*$/.test(opts.subject)
      ? opts.subject
      : `=?UTF-8?B?${Buffer.from(opts.subject, "utf8").toString("base64")}?=`;
    const body = opts.text.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    const message =
      `From: ${env.smtpFrom}\r\n` +
      `To: ${opts.to}\r\n` +
      `Subject: ${encodedSubject}\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=UTF-8; format=flowed\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n` +
      `\r\n${body}\r\n.`;

    const expect2xx = (r: { code: number; lines: string[] }, where: string): void => {
      const s = String(r.code);
      if (!/^2\d\d$/.test(s) && !/^3\d\d$/.test(s)) {
        throw new Error(`SMTP ${where} ${r.code}: ${r.lines.join(" · ")}`);
      }
    };

    const sock = env.smtpSecure
      ? tls.connect({ host: env.smtpHost, port: env.smtpPort })
      : net.connect(env.smtpPort, env.smtpHost);
    this.attach(sock);
    sock.setTimeout(30_000, () => {
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        p.reject(new Error("SMTP timeout"));
      }
    });

    const greeting = await this.readReply();
    if (greeting.code !== 220) throw new Error(`SMTP greeting ${greeting.code}`);

    let r = await this.cmd(`EHLO ${os.hostname()}`);
    if (!/^2\d\d$/.test(String(r.code))) throw new Error(`EHLO ${r.code}: ${r.lines.join(" · ")}`);

    if (!env.smtpSecure && /STARTTLS/i.test(r.lines.join(" "))) {
      r = await this.cmd("STARTTLS");
      if (r.code !== 220) throw new Error(`STARTTLS ${r.code}`);
      await this.upgradeTls();
      r = await this.cmd(`EHLO ${os.hostname()}`);
      if (!/^2\d\d$/.test(String(r.code))) throw new Error(`EHLO(tls) ${r.code}: ${r.lines.join(" · ")}`);
    }

    if (env.smtpUser) {
      const cred = Buffer.from(`\u0000${env.smtpUser}\u0000${env.smtpPass}`, "utf8").toString("base64");
      r = await this.cmd(`AUTH PLAIN ${cred}`);
      if (!/^235$/.test(String(r.code))) throw new Error(`AUTH ${r.code}: ${r.lines.join(" · ")}`);
    }

    r = await this.cmd(`MAIL FROM:<${fromAddr}>`);
    expect2xx(r, "MAIL FROM");
    r = await this.cmd(`RCPT TO:<${opts.to}>`);
    expect2xx(r, "RCPT TO");
    r = await this.cmd("DATA");
    if (r.code !== 354) throw new Error(`DATA ${r.code}: ${r.lines.join(" · ")}`);
    r = await this.cmd(message);
    if (!/^2\d\d$/.test(String(r.code))) throw new Error(`message ${r.code}: ${r.lines.join(" · ")}`);
    r = await this.cmd("QUIT");
    void r;
    this.sock.end();
  }
}

/** Send an email via the configured SMTP relay. Throws on failure. */
export function sendEmail(opts: { to: string; subject: string; text: string }): Promise<void> {
  const session = new SmtpSession();
  return session.send(opts);
}