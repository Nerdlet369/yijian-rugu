FROM node:20-alpine

WORKDIR /app
COPY . .

ENV HOST=0.0.0.0
ENV PORT=8081
EXPOSE 8081

CMD ["node", "server.js"]
