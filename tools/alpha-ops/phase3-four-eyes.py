"""Executed by `odoo shell` against the running Alpha database."""
import base64
import json
import os

from odoo.exceptions import AccessError, UserError


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise UserError("Phase-3-Parameter %s fehlt." % name)
    return value


invitation = env["zugfolge.alpha.invitation"].search([
    ("request_reference", "=", required("PHASE3_INVITATION_REFERENCE")),
], limit=1)
requester = env["res.users"].search([("login", "=", required("PHASE3_REQUESTER_LOGIN"))], limit=1)
approver = env["res.users"].search([("login", "=", required("PHASE3_APPROVER_LOGIN"))], limit=1)
if not invitation or invitation.state != "provisioned" or not invitation.keycloak_subject:
    raise UserError("Phase-3-Einladung ist nicht autoritativ bereitgestellt oder bereits entzogen.")
if not requester.has_group("zugfolge_admin.group_zugfolge_admin"):
    raise AccessError("Der Antragsteller gehoert nicht zur Zugfolge-Administration.")
if not approver.has_group("zugfolge_admin.group_zugfolge_approver"):
    raise AccessError("Der zweite Benutzer besitzt keine Freigaberolle.")
if requester == approver:
    raise AccessError("Vier-Augen-Drill braucht zwei verschiedene Odoo-Benutzer.")

action = invitation.with_user(requester).action_revoke()
admin_request = env["zugfolge.admin.request"].browse(action["res_id"])
admin_request.with_user(requester).action_submit()
admin_request.with_user(approver).action_approve()
env["ir.attachment"].create({
    "name": "phase-3-restore-probe.txt",
    "type": "binary",
    "datas": base64.b64encode(("restore-probe:%s" % admin_request.correlation_id).encode("utf-8")),
    "res_model": "zugfolge.admin.request",
    "res_id": admin_request.id,
    "mimetype": "text/plain",
})
admin_request.with_user(requester).action_dispatch()
env.cr.commit()
print("PHASE3_FOUR_EYES=" + json.dumps({
    "correlationId": admin_request.correlation_id,
    "worldId": invitation.world_projection_id.world_id,
    "keycloakSubject": invitation.keycloak_subject,
    "adminRequestId": admin_request.id,
}, sort_keys=True, separators=(",", ":")))
