FROM oven/bun:1
WORKDIR /app

COPY package.json bun.lock ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN DATABASE_URL="postgresql://placeholder:5432/db" bun install --frozen-lockfile

COPY . .

EXPOSE 8080
ENV PORT=8080

CMD ["bun", "run", "index.ts"]
