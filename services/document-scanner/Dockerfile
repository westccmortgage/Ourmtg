FROM node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends clamav clamav-daemon \
  && rm -rf /var/lib/apt/lists/* \
  && sed -i 's/^Foreground .*/Foreground true/' /etc/clamav/clamd.conf \
  && sed -i 's#^LocalSocket .*#LocalSocket /run/clamav/clamd.ctl#' /etc/clamav/clamd.conf

WORKDIR /app
COPY server.mjs start.sh ./
RUN chmod 0555 /app/start.sh && chmod 0444 /app/server.mjs

ENV PORT=8080
EXPOSE 8080
CMD ["/app/start.sh"]

