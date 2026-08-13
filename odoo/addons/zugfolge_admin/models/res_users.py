from ast import literal_eval

from odoo import _, fields, models
from odoo.exceptions import AccessDenied


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
        user.partner_id.sudo().write({"zugfolge_keycloak_subject": subject})
        return user.login
