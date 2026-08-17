# Local Nginx WASM host: Kong's ngx_wasm_module (Wasmtime backend).
#
# Uses Kong's official prebuilt release binary — a real nginx with the module
# compiled in — pinned by exact release tag + sha256. (The plan originally
# assumed source-only distribution; releases ship binaries, verified 2026-07-11.)
#
# consent_filter.wasm is volume-mounted at /wasm/, not baked in, so rebuilding
# the filter never rebuilds this image.

FROM docker.io/library/ubuntu:22.04

ARG WASMX_VERSION=prerelease-0.6.0
ARG WASMX_SHA256=5997a6ec5e67d54dc43c0fe7af7ccd0558cfe39eb4f87080fbe6f4f0f68a1ce9

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN curl -sSL -o /tmp/wasmx.tar.gz \
      "https://github.com/Kong/ngx_wasm_module/releases/download/${WASMX_VERSION}/wasmx-${WASMX_VERSION}-wasmtime-x86_64-ubuntu22.04.tar.gz" \
 && echo "${WASMX_SHA256}  /tmp/wasmx.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/wasmx \
 && tar xzf /tmp/wasmx.tar.gz -C /opt/wasmx --strip-components=1 \
 && rm /tmp/wasmx.tar.gz \
 && /opt/wasmx/nginx -V

COPY nginx.conf /opt/wasmx/nginx.conf
RUN mkdir -p /opt/wasmx/logs

EXPOSE 3132

CMD ["/opt/wasmx/nginx", "-p", "/opt/wasmx", "-c", "nginx.conf", "-g", "daemon off;"]
