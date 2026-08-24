import path from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";

const databaseFile = path.resolve(__dirname, "../../prisma/dev.db");

const adapter = new PrismaBetterSqlite3({ url: `file:${databaseFile}` });

export const prisma = new PrismaClient({ adapter });
