FROM ghcr.io/puppeteer/puppeteer:latest

WORKDIR /app

# Copia package e instala deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o restante
COPY . .

# Render usa a env PORT
ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
