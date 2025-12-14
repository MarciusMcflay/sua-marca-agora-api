FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PUPPETEER_SKIP_DOWNLOAD=true

EXPOSE 10000
CMD ["npm", "start"]
