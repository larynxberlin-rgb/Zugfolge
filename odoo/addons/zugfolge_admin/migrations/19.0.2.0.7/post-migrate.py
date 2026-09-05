from odoo import SUPERUSER_ID, api
from odoo.addons.zugfolge_admin.upgrade import remove_retired_learning_worlds


def migrate(cr, _version):
    remove_retired_learning_worlds(api.Environment(cr, SUPERUSER_ID, {}))
