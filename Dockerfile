FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=33219
COPY --from=build /app/dist ./dist
COPY server.js ./server.js
COPY package.json ./package.json
EXPOSE 33219
CMD ["npm", "start"]
