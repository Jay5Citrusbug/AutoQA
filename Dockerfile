# Stage 1: Build the app
FROM mcr.microsoft.com/playwright:v1.49.0-noble AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: Minimal run environment
FROM mcr.microsoft.com/playwright:v1.49.0-noble AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Copy build artifacts and environment files
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts

# Create evidence and output directories inside container volume
RUN mkdir -p screenshots reports generated-tests logs videos test-runs

EXPOSE 3000

CMD ["npm", "run", "start"]
