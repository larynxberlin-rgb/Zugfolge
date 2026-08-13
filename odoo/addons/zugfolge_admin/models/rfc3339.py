import re
from datetime import datetime, timezone

from odoo import _
from odoo.exceptions import ValidationError


RFC3339_WITH_ZONE = re.compile(r"^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$")


def rfc3339_utc(value, field_name, required=True):
    """Validate an integration timestamp and return Odoo's naive UTC value."""
    if value is None and not required:
        return False
    if not isinstance(value, str) or not RFC3339_WITH_ZONE.fullmatch(value):
        raise ValidationError(_("%(field)s braucht einen RFC3339-Zeitstempel mit Zeitzone.", field=field_name))
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValidationError(_("%(field)s braucht einen gueltigen RFC3339-Zeitstempel.", field=field_name)) from error
    if parsed.utcoffset() is None:
        raise ValidationError(_("%(field)s braucht eine explizite Zeitzone.", field=field_name))
    return parsed.astimezone(timezone.utc).replace(tzinfo=None)
