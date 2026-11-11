FROM node:20-alpine
WORKDIR /app
COPY package.json server.js favicon.svg ./
COPY fonts ./fonts
RUN mkdir -p data/images
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
