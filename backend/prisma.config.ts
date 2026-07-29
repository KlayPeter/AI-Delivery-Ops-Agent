import { defineConfig } from "prisma/config";

process.env.DATABASE_URL ||= "file:../../data/data.db";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  }
});
