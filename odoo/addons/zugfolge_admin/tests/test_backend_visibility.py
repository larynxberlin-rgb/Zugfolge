from odoo import Command
from odoo.tests.common import TransactionCase


class TestZugfolgeBackendVisibility(TransactionCase):
    def test_builtin_admin_can_open_zugfolge_app(self):
        admin = self.env.ref("base.user_admin")
        self.assertTrue(admin.has_group("zugfolge_admin.group_zugfolge_admin"))
        for restricted_group in (
            "group_zugfolge_approver",
            "group_zugfolge_telemetry",
            "group_zugfolge_infra_reviewer",
        ):
            self.assertFalse(admin.has_group(f"zugfolge_admin.{restricted_group}"))

        root_menu = self.env.ref("zugfolge_admin.menu_zugfolge_root")
        monitoring_action = self.env.ref("zugfolge_admin.action_zugfolge_world_projection")
        self.assertEqual(root_menu.action, monitoring_action)
        self.assertIn(root_menu.id, self.env["ir.ui.menu"].with_user(admin)._visible_menu_ids())

    def test_normal_internal_user_cannot_see_zugfolge_app(self):
        user = self.env["res.users"].with_context(no_reset_password=True).create({
            "name": "Zugfolge Outside Staff",
            "login": "zugfolge-outside-staff@example.test",
            "group_ids": [Command.set([self.env.ref("base.group_user").id])],
        })
        root_menu = self.env.ref("zugfolge_admin.menu_zugfolge_root")
        infra_menu = self.env.ref("zugfolge_admin.menu_zugfolge_infra_release_imports")
        visible_menus = self.env["ir.ui.menu"].with_user(user)._visible_menu_ids()
        self.assertNotIn(root_menu.id, visible_menus)
        self.assertNotIn(infra_menu.id, visible_menus)

    def test_roles_are_independently_manageable_odoo_privileges(self):
        role_to_privilege = {
            "group_zugfolge_admin": "privilege_zugfolge_admin",
            "group_zugfolge_approver": "privilege_zugfolge_approver",
            "group_zugfolge_telemetry": "privilege_zugfolge_telemetry",
            "group_zugfolge_infra_reviewer": "privilege_zugfolge_infra_reviewer",
        }
        privileges = self.env["res.groups.privilege"]
        for group_xmlid, privilege_xmlid in role_to_privilege.items():
            group = self.env.ref(f"zugfolge_admin.{group_xmlid}")
            privilege = self.env.ref(f"zugfolge_admin.{privilege_xmlid}")
            self.assertEqual(group.privilege_id, privilege)
            self.assertEqual(privilege.category_id, self.env.ref("base.module_category_administration"))
            privileges |= privilege
        self.assertEqual(len(privileges), 4)
