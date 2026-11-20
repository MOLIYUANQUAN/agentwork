# agentwork 的服务器镜像：先把网页构建好，再装进一个只有 Python 的小镜像里。
#   docker build -t agentwork .
#   docker run -d --name agentwork -p 8787:8787 -v agentwork-data:/data --env-file .env agentwork
# 怎么配域名和 https，见 docs/部署.md。

FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 \
    AGENTWORK_HOST=0.0.0.0 \
    AGENTWORK_DATA=/data \
    AGENTWORK_NO_BROWSER=1 \
    AGENTWORK_NO_SEED=1 \
    AGENTWORK_FAKE_AI=0 \
    AGENTWORK_TRUSTED_PROXIES=*
WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server/ server/
COPY connector/ connector/
COPY --from=web /web/dist web/dist
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=2).status == 200 else 1)"
CMD ["python", "-m", "server.launch"]
