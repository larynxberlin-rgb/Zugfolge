from odoo import api, fields, models
from odoo.exceptions import AccessError


class ZugfolgeProjectionReceipt(models.Model):
    """Idempotency and reconciliation receipt; contains no Game domain state."""

    _name = "zugfolge.projection.receipt"
    _description = "Zugfolge Projektionsbeleg"
    _order = "received_at desc"

    message_id = fields.Char(required=True, index=True, readonly=True)
    world_id = fields.Char(required=True, index=True, readonly=True)
    correlation_id = fields.Char(required=True, readonly=True)
    payload_hash = fields.Char(required=True, readonly=True)
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
