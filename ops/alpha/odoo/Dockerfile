FROM odoo:19.0-20260723
USER root
ARG OCA_QUEUE_COMMIT=d2c1759102f1e0bc8f6244629b5b38c7b7882f36
ARG ZUGFOLGE_SOURCE_SHA
ARG ZUGFOLGE_DEPLOY_PATCH_SHA
LABEL org.opencontainers.image.source="https://github.com/larynxberlin-rgb/Zugfolge" \
  org.opencontainers.image.revision="${ZUGFOLGE_SOURCE_SHA}" \
  de.zugfolge.deploy-patch="${ZUGFOLGE_DEPLOY_PATCH_SHA}"
RUN printf '%s\n' "${ZUGFOLGE_SOURCE_SHA}" | grep -Eq '^[0-9a-f]{40}$' \
 && test "${ZUGFOLGE_DEPLOY_PATCH_SHA}" = "none"
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /opt/zugfolge-addons/queue_job \
 && curl -fsSL "https://github.com/OCA/queue/archive/${OCA_QUEUE_COMMIT}.tar.gz" \
 | tar -xz --strip-components=2 -C /opt/zugfolge-addons/queue_job "queue-${OCA_QUEUE_COMMIT}/queue_job" \
 && pip3 install --no-cache-dir --break-system-packages openupgradelib
COPY --chown=odoo:odoo odoo/addons/zugfolge_admin /opt/zugfolge-addons/zugfolge_admin
USER odoo
