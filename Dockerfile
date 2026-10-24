FROM node:20-alpine
WORKDIR /app
COPY epm-notifier.mjs .
ENV STATE_FILE=/data/seen.json
USER node
CMD ["node", "epm-notifier.mjs"]
