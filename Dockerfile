# ffmpeg is for merging session video chunks and extracting export frames.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV PORT=7900 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 7900
CMD ["node", "src/server.mjs"]
