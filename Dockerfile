FROM node:20-alpine

WORKDIR /app

# Zero runtime dependencies: only project sources are needed.
COPY package.json ./
COPY src ./src
COPY web ./web
COPY tests ./tests
COPY scripts ./scripts

# Page build check runs at image build time as well (fails image on errors).
RUN node scripts/build.mjs

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/server.mjs"]
