from ast import literal_eval

from odoo import _, api, fields, models
from odoo.exceptions import AccessDenied, AccessError


_KEYCLOAK_BIND_TOKEN = object()


def validate_keycloak_identity(validation):
    if validation.get("email_verified") is not True:
        raise AccessDenied(_("Keycloak-E-Mail ist noch nicht verifiziert."))
    if not validation.get("email") or not (validation.get("sub") or validation.get("user_id")):
        raise AccessDenied(_("Keycloak liefert keine stabile verifizierte Portalidentitaet."))
    return validation.get("sub") or validation.get("user_id")


class AuthOAuthProvider(models.Model):
    _inherit = "auth.oauth.provider"

    zugfolge_keycloak_provider = fields.Boolean(
        string="Zugfolge Keycloak",
        help="Erzwingt email_verified und provisioniert neue Nutzer ausschliesslich als Portalprofil.",
    )


class ResPartner(models.Model):
    _inherit = "res.partner"

    zugfolge_keycloak_subject = fields.Char(index=True, copy=False)

    _sql_constraints = [("zugfolge_keycloak_subject", "unique(zugfolge_keycloak_subject)", "Ein Keycloak-sub darf nur einem Odoo-Portalprofil zugeordnet sein.")]

    @api.model_create_multi
    def create(self, values_list):
        if self.env.context.get("zugfolge_keycloak_bind_token") is not _KEYCLOAK_BIND_TOKEN:
            if any(values.get("zugfolge_keycloak_subject") for values in values_list):
                raise AccessError(_("Keycloak-sub darf nur durch einen verifizierten OIDC-Login gebunden werden."))
        return super().create(values_list)

    def write(self, values):
        if "zugfolge_keycloak_subject" in values:
            if self.env.context.get("zugfolge_keycloak_bind_token") is not _KEYCLOAK_BIND_TOKEN:
                raise AccessError(_("Keycloak-sub darf nur durch einen verifizierten OIDC-Login gebunden werden."))
            subject = values.get("zugfolge_keycloak_subject")
            if not isinstance(subject, str) or not subject.strip():
                raise AccessDenied(_("Keycloak liefert keine stabile Portalidentitaet."))
            if any(record.zugfolge_keycloak_subject and record.zugfolge_keycloak_subject != subject for record in self):
                raise AccessDenied(_("Eine bestehende Portalidentitaet darf nicht auf ein anderes Keycloak-sub umgebunden werden."))
        return super().write(values)

    def _bind_zugfolge_keycloak_subject(self, subject):
        self.ensure_one()
        if not isinstance(subject, str) or not subject.strip():
            raise AccessDenied(_("Keycloak liefert keine stabile Portalidentitaet."))
        return self.sudo().with_context(zugfolge_keycloak_bind_token=_KEYCLOAK_BIND_TOKEN).write({
            "zugfolge_keycloak_subject": subject,
        })


class ResUsers(models.Model):
    _inherit = "res.users"

    def _auth_oauth_validate(self, provider, access_token):
        validation = super()._auth_oauth_validate(provider, access_token)
        provider_record = self.env["auth.oauth.provider"].browse(provider)
        if provider_record.zugfolge_keycloak_provider:
            validate_keycloak_identity(validation)
        return validation

    def _auth_oauth_signin(self, provider, validation, params):
        provider_record = self.env["auth.oauth.provider"].browse(provider)
        if not provider_record.zugfolge_keycloak_provider:
            return super()._auth_oauth_signin(provider, validation, params)
        subject = validate_keycloak_identity(validation)
        oauth_uid = validation.get("user_id") or subject
        user = self.search([("oauth_provider_id", "=", provider), ("oauth_uid", "=", oauth_uid)], limit=1)
        if not user:
            # Der offizielle OAuth-Flow soll auch bei globalem B2B-Signup ohne
            # Admin-Voranlage funktionieren. Er kopiert ausschliesslich die
            # von Odoo konfigurierte Portalvorlage, niemals einen internen User.
            template_id = literal_eval(self.env["ir.config_parameter"].sudo().get_param("base.template_portal_user_id", "False"))
            template_user = self.browse(template_id)
            if not template_user.exists() or template_user._is_internal():
                raise AccessDenied(_("Die Odoo-Portalvorlage fuer Keycloak ist nicht sicher konfiguriert."))
            values = self._generate_signup_values(provider, validation, params)
            user = self._create_user_from_template(values)
        else:
            user.write({"oauth_access_token": params["access_token"]})
        if user._is_internal():
            raise AccessDenied(_("Keycloak-Login darf nur ein Odoo-Portalprofil erzeugen."))
        user.partner_id._bind_zugfolge_keycloak_subject(subject)
        return user.login
