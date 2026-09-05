from odoo.tests.common import TransactionCase

from ..upgrade import remove_retired_learning_worlds


class TestRetiredWorldUpgrade(TransactionCase):
    def test_removes_old_projection_and_preserves_regular_world_idempotently(self):
        model = self.env["zugfolge.world.projection"].with_context(zugfolge_game_projection=True)
        records = []
        for world_id in ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]:
            records.append(model.create({
                "world_id": world_id, "world_name": "Upgradeprüfung",
                "projection_revision": "test-1", "observed_at": "2026-01-01 00:00:00",
                "freshness": "live", "simulation_time": "2026-01-01 00:00:00",
                "payload_hash": "a" * 64, "profile_kind": "private",
            }))
        regular, retired = records
        attachments = self.env["ir.attachment"].create([
            {"name": "regular.txt", "datas": "cmVndWxhcg==", "res_model": model._name, "res_id": regular.id},
            {"name": "retired.txt", "datas": "cmV0aXJlZA==", "res_model": model._name, "res_id": retired.id},
        ])
        reference = self.env["ir.model.data"].create({
            "module": "zugfolge_admin", "name": "retired_upgrade_fixture",
            "model": model._name, "res_id": retired.id,
        })
        self.env.flush_all()
        self.env.cr.execute("UPDATE zugfolge_world_projection SET profile_kind = 'tutorial' WHERE id = %s", [retired.id])
        self.env.invalidate_all()
        remove_retired_learning_worlds(self.env)
        self.assertFalse(retired.exists())
        self.assertTrue(regular.exists())
        self.assertTrue(attachments[0].exists())
        self.assertFalse(attachments[1].exists())
        self.assertFalse(reference.exists())
        self.assertEqual(regular.profile_kind, "private")
        self.assertEqual(remove_retired_learning_worlds(self.env), 0)
