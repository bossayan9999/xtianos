import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { env } from '../lib/env';
import { GeneratedImage } from './image-service';
import { prisma } from '../lib/db';

export interface VideoFrame {
  index: number;
  prompt: string;
  image: GeneratedImage;
}

export interface StoryboardResult {
  artifactId: number;
  videoUrl: string;
  frames: VideoFrame[];
  duration: number; // seconds
}

/**
 * Generate a storyboard (sequence of keyframe prompts) from a narrative.
 * Used by creative agent to break down visual stories frame-by-frame.
 */
export async function generateStoryboardFrames(
  narrative: string,
  frameCount: number = 5,
): Promise<string[]> {
  // In production, this would call an LLM to break down the narrative
  // For now, return placeholder prompts
  const frames: string[] = [];
  const lines = narrative.split('\n').filter((l) => l.trim());

  for (let i = 0; i < frameCount && i < lines.length; i++) {
    frames.push(`Scene ${i + 1}: ${lines[i]}`);
  }

  return frames;
}

/**
 * Composite multiple images into a video file.
 * Requires ffmpeg installed on the system.
 */
export async function compositeImagesToVideo(
  frames: GeneratedImage[],
  fps: number = 2,
  outputPath: string = `${env.workspaceDir}/output.mp4`,
): Promise<{ success: boolean; path: string; size: number }> {
  try {
    const { spawn } = await import('node:child_process');
    const { mkdtemp } = await import('node:fs/promises');
    const tmpDir = await mkdtemp(path.join(env.workspaceDir, 'frames_'));

    // Write frames to disk
    for (let i = 0; i < frames.length; i++) {
      const framePath = path.join(tmpDir, `frame_${String(i).padStart(5, '0')}.png`);
      await fsp.writeFile(
        framePath,
        Buffer.from(frames[i].base64, 'base64'),
      );
    }

    // Run ffmpeg
    return await new Promise((resolve) => {
      const ffmpeg = spawn('ffmpeg', [
        '-framerate',
        String(fps),
        '-i',
        path.join(tmpDir, 'frame_%05d.png'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        outputPath,
      ]);

      ffmpeg.on('close', async (code) => {
        try {
          await fsp.rm(tmpDir, { recursive: true });
        } catch {
          /* ignore cleanup errors */
        }

        if (code === 0) {
          const stats = await fsp.stat(outputPath);
          resolve({
            success: true,
            path: outputPath,
            size: stats.size,
          });
        } else {
          resolve({
            success: false,
            path: '',
            size: 0,
          });
        }
      });
    });
  } catch (err) {
    console.error('Video composition failed:', err);
    return { success: false, path: '', size: 0 };
  }
}

/**
 * Persist video as artifact.
 */
export async function persistVideo(
  videoPath: string,
  prompt: string,
  conversationId: number | null,
): Promise<{ id: number; filename: string; mime: string }> {
  const stats = await fsp.stat(videoPath);
  const fileContent = await fsp.readFile(videoPath);
  const base64 = fileContent.toString('base64');
  const filename = `video_${Date.now()}.mp4`;

  const artifact = await prisma.artifact.create({
    data: {
      conversationId,
      kind: 'video',
      filename,
      mime: 'video/mp4',
      contentBase64: base64,
      textPreview: prompt.slice(0, 500),
    },
  });

  return {
    id: artifact.id,
    filename,
    mime: 'video/mp4',
  };
}
