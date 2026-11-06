FROM node:24-alpine AS build
RUN npm ci
FROM node:24-alpine
CMD ["node","dist/main.js"]
