# pg-lens-mcp — read-only PostgreSQL explainer (MCP server, stdio)
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
# pg-lens refuses to start without DATABASE_URL. The pool connects lazily,
# so this placeholder lets the server boot and answer introspection
# (initialize / tools/list); real deployments override it with a live URL.
ENV DATABASE_URL=postgres://pglens:pglens@localhost:5432/shop
CMD ["node", "dist/src/index.js"]
