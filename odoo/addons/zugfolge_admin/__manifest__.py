{
    "name": "Zugfolge Administration",
    "summary": "Signierte Game-Projektionen, Freigaben und Monitoring fuer Zugfolge",
    "version": "19.0.1.3.0",
    "category": "Administration",
    "license": "Other proprietary",
    "author": "Zugfolge",
    "depends": ["base", "mail", "contacts", "crm", "account", "payment", "queue_job"],
    "data": [
        "security/zugfolge_admin_security.xml",
        "security/ir.model.access.csv",
        "views/zugfolge_admin_views.xml",
    ],
    "assets": {
        "web.assets_backend": ["zugfolge_admin/static/src/scss/zugfolge_admin.scss"],
    },
    "installable": True,
    "application": True,
}
