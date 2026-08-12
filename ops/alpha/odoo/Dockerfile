FROM odoo:19.0-20260723
USER root
ARG OCA_QUEUE_COMMIT=d2c1759102f1e0bc8f6244629b5b38c7b7882f36
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /mnt/extra-addons/queue_job \
 && curl -fsSL "https://github.com/OCA/queue/archive/${OCA_QUEUE_COMMIT}.tar.gz" \
 | tar -xz --strip-components=2 -C /mnt/extra-addons/queue_job "queue-${OCA_QUEUE_COMMIT}/queue_job" \
 && pip3 install --no-cache-dir --break-system-packages openupgradelib
COPY --chown=odoo:odoo odoo/addons/zugfolge_admin /mnt/extra-addons/zugfolge_admin
USER odoo
