from odoo import fields, models


class ZugfolgeFeedback(models.Model):
    """Native Odoo activity-backed feedback, always linked to a defined projection."""

    _name = "zugfolge.feedback"
    _description = "Zugfolge Feedback"
    _inherit = ["mail.thread", "mail.activity.mixin"]
    _order = "create_date desc"

    name = fields.Char(required=True, tracking=True)
    world_projection_id = fields.Many2one("zugfolge.world.projection", required=True, ondelete="restrict", index=True)
    period_reference = fields.Char()
    release_hash = fields.Char()
    metric_key = fields.Char()
    authoritative_event_url = fields.Char()
    report_reference = fields.Char()
    body = fields.Html(required=True)
