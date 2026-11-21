FROM node:20-alpine
WORKDIR /app
COPY server.mjs peer.html ./
ENV MOCK_GRAPH_PORT=443
ENV MOCK_PEER_PORT=38090
EXPOSE 443 38090
CMD ["node", "server.mjs"]
