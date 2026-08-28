from odoo import api, fields, models
from odoo.exceptions import AccessError


PROJECTION_ENVELOPE_HASH_SCHEMA = "zugfolge-projection-envelope-sha256/v1"


class ZugfolgeProjectionReceipt(models.Model):
    """Idempotency and reconciliation receipt; contains no Game domain state."""

    _name = "zugfolge.projection.receipt"
    _description = "Zugfolge Projektionsbeleg"
    _order = "received_at desc"

    message_id = fields.Char(required=True, index=True, readonly=True)
    world_id = fields.Char(required=True, index=True, readonly=True)
    correlation_id = fields.Char(required=True, readonly=True)
    # payload_hash is the legacy v1 body-only reconciliation digest.  It must
    # remain available, but it is never sufficient to authorize a replay.
    payload_hash = fields.Char(required=True, readonly=True)
    # These fields intentionally stay nullable during an upgrade: a legacy
    # receipt cannot be reconstructed from its body digest.  The controller
    # treats a missing or unknown binding as replay_conflict.
    envelope_hash_schema = fields.Selection(
        [(PROJECTION_ENVELOPE_HASH_SCHEMA, "Kanonischer Projektionsumschlag SHA-256 v1")],
        readonly=True,
        copy=False,
    )
    envelope_hash = fields.Char(readonly=True, copy=False)
    received_at = fields.Datetime(required=True, readonly=True, default=fields.Datetime.now)

    _message_id_unique = models.Constraint(
        "unique(message_id)",
        "Eine Projektion darf nur einmal angenommen werden.",
    )

    @api.model_create_multi
    def create(self, values_list):
        if not self.env.context.get("zugfolge_game_projection"):
            raise AccessError("Projektionsbelege werden nur über den signierten Integrationspfad erzeugt.")
        return super().create(values_list)

    def write(self, values):
        raise AccessError("Projektionsbelege sind unveränderlich.")

    def unlink(self):
        raise AccessError("Projektionsbelege sind unveränderlich.")
