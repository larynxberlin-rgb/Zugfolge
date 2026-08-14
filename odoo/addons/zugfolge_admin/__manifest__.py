{
    "name": "Zugfolge Administration",
    "summary": "Signierte Game-Projektionen, Freigaben und Monitoring fuer Zugfolge",
    "version": "19.0.2.0.3",
    "category": "Administration",
    "license": "Other proprietary",
    "author": "Zugfolge",
    "depends": ["base", "mail", "contacts", "crm", "account", "payment", "product", "sale_management", "website", "portal", "website_sale", "website_forum", "auth_oauth", "auth_signup", "queue_job"],
    "data": [
        "security/zugfolge_admin_security.xml",
        "security/ir.model.access.csv",
        "views/zugfolge_admin_views.xml",
        "views/world_offer_views.xml",
        "views/website_templates.xml",
        "views/snippets.xml",
    ],
    "assets": {
        "web.assets_backend": ["zugfolge_admin/static/src/scss/zugfolge_admin.scss"],
        "web.assets_frontend": [
            "zugfolge_admin/static/src/scss/website.scss",
            "zugfolge_admin/static/src/js/world_snippets.js",
        ],
        "website.assets_wysiwyg": ["zugfolge_admin/static/src/scss/website.scss"],
        "website.website_builder_assets": [
            "zugfolge_admin/static/src/website_builder/world_snippet_option_plugin.js",
            "zugfolge_admin/static/src/website_builder/world_snippet_option.xml",
        ],
    },
    "installable": True,
    "application": True,
}
