import base64
import json
from unittest.mock import patch

from odoo import Command
from odoo.exceptions import AccessError, ValidationError
from odoo.tests.common import TransactionCase

from .test_demand_data_contract import release_fixture
from ..models import demand_data as module


WORLD = "11111111-1111-4111-8111-111111111111"


class TestDemandData(TransactionCase):
    def setUp(self):
        super().setUp()
        self.admin = self.env.ref("base.user_admin")
        self.data = self.env["zugfolge.demand.data"].with_user(self.admin).create({
            "name": "Einwohnerkorrektur", "world_id": WORLD,
            "initial_file": base64.b64encode(json.dumps(release_fixture()).encode()),
            "initial_filename": "fixture.json",
        })
        # Keep queue_job real. Only its external HTTP delivery is deferred, as in production.
        self.data.action_import()

    def test_save_updates_database_and_queues_one_exact_revision(self):
        source = self.data.base_release
        town = self.data.settlement_ids.filtered(lambda line: line.settlement_id == "town-a")
        initial_revision = self.data.source_revision
        town.with_context(default_state="accepted", default_result_json={"outcome": "accepted"}).write({"population": 101})
        self.assertEqual(town.original_population, 100)
        self.assertEqual(self.data.base_release, source)
        self.assertEqual(self.data.source_revision, initial_revision + 1)
        self.assertEqual(sum(self.data.allocation_ids.filtered(lambda line: line.settlement_ref_id == town).mapped("population")), 101)
        event = self.data.event_ids.filtered(lambda row: row.source_revision == self.data.source_revision)
        self.assertEqual(event.command_json["kind"], "demand.data.update")
        self.assertEqual(event.command_json["sourceRevision"], self.data.source_revision)
        self.assertEqual(event.editor_id, self.admin)
        self.assertEqual(event.state, "queued")
        town.write({"population": 101})
        self.assertEqual(self.data.source_revision, initial_revision + 1)

    def test_parent_form_saves_multiple_shares_atomically(self):
        lines = self.data.allocation_ids.filtered(lambda line: line.settlement_ref_id.settlement_id == "town-a").sorted(lambda line: line.station_ref_id.zone_id)
        revision = self.data.source_revision
        self.data.write({"allocation_ids": [Command.update(lines[0].id, {"population": 50}), Command.update(lines[1].id, {"population": 50})]})
        self.assertEqual(self.data.source_revision, revision + 1)
        self.assertEqual(lines.mapped("population"), [50, 50])
        with self.assertRaises(ValidationError), self.cr.savepoint():
            lines[0].write({"population": 51})

    def test_new_known_station_pair_and_zero_hint_save_immediately(self):
        stations = self.data.station_ids.sorted("zone_id")
        revision = self.data.source_revision
        self.data.write({"connection_ids": [Command.create({"origin_id": stations[1].id, "destination_id": stations[0].id, "connections": 12})]})
        self.assertEqual(self.data.source_revision, revision + 1)
        self.data.connection_ids.filtered(lambda line: line.origin_id == stations[0]).write({"connections": 0})
        latest = self.data.event_ids.filtered(lambda event: event.source_revision == self.data.source_revision)
        self.assertEqual(latest.command_json["populationModel"]["destinationPreferences"], [{"originZoneId": "b", "destinationZoneId": "a", "referenceConnections": 12}])

    def test_originals_identifiers_and_nested_rpc_writes_are_protected(self):
        town = self.data.settlement_ids[:1]
        for values in ({"base_release": {}}, {"source_revision": 99}, {"world_id": "22222222-2222-4222-8222-222222222222"},
                       {"settlement_ids": [Command.update(town.id, {"original_population": 1})]},
                       {"settlement_ids": [Command.update(town.id, {"settlement_id": "spoofed"})]}):
            with self.subTest(values=values), self.assertRaises(AccessError), self.cr.savepoint():
                self.data.write(values)
        for context in ({module._WRITE_KEY: True}, {module._BATCH_KEY: True}):
            with self.subTest(context=context), self.assertRaises(AccessError), self.cr.savepoint():
                town.with_context(**context).write({"population": 1})
        for value in (True, 1.5, "100", -1):
            with self.subTest(value=value), self.assertRaises(ValidationError), self.cr.savepoint():
                town.write({"population": value})
        with self.assertRaises(AccessError), self.cr.savepoint():
            self.env["zugfolge.demand.data"].with_user(self.admin).with_context(default_base_release={"id": "spoofed"}).create({"world_id": WORLD})
        with self.assertRaises(AccessError), self.cr.savepoint():
            self.env["zugfolge.demand.connection"].with_user(self.admin).with_context(default_original_connections=99).create({
                "data_id": self.data.id, "origin_id": self.data.station_ids[1].id,
                "destination_id": self.data.station_ids[0].id, "connections": 1,
            })
        event = self.data.event_ids[:1]
        with self.assertRaises(AccessError), self.cr.savepoint():
            event.write({"command_json": {}})
        with self.assertRaises(AccessError), self.cr.savepoint():
            event.unlink()

    def test_foreign_records_and_unauthorized_roles_cannot_edit(self):
        other = self.env["zugfolge.demand.data"].with_user(self.admin).create({"world_id": "22222222-2222-4222-8222-222222222222"})
        with self.assertRaises(AccessError), self.cr.savepoint():
            self.data.allocation_ids[:1].write({"data_id": other.id})
        for role in ("base.group_user", "base.group_portal", "zugfolge_admin.group_zugfolge_telemetry"):
            user = self.env["res.users"].with_context(no_reset_password=True).create({"name": role, "login": "demand-" + role,
                "group_ids": [Command.set([self.env.ref(role).id])]})
            with self.subTest(role=role), self.assertRaises(AccessError), self.cr.savepoint():
                self.data.with_user(user).write({"name": "forbidden"})
            with self.subTest(role=role), self.assertRaises(AccessError), self.cr.savepoint():
                self.data.settlement_ids[:1].with_user(user).write({"population": 100})
            self.assertNotIn(self.env.ref("zugfolge_admin.menu_zugfolge_demand_data").id, self.env["ir.ui.menu"].with_user(user)._visible_menu_ids())

    def test_delivery_retry_uses_frozen_revision_and_result_tracks_that_revision(self):
        event = self.data.event_ids[:1]
        frozen = event.command_json
        self.data.settlement_ids.filtered(lambda line: line.settlement_id == "town-a").write({"population": 110})
        with patch.object(module, "dispatch_signed_game_command") as dispatch:
            event._dispatch(); event._dispatch()
            self.assertEqual(dispatch.call_count, 2)
            self.assertEqual(dispatch.call_args.args[1:], (event.correlation_id, "admin-service", frozen))
        event._apply_game_result({"baseReleaseId": self.data.base_release_id, "sourceRevision": event.source_revision, "outcome": "accepted"})
        self.assertEqual(event.state, "accepted")
        self.assertEqual(self.data.sync_state, "queued")
        with self.assertRaises(ValidationError), self.cr.savepoint():
            event._apply_game_result({"baseReleaseId": "foreign", "sourceRevision": event.source_revision, "outcome": "rejected"})

    def test_native_form_exposes_editable_tables_and_computed_classes(self):
        from lxml import etree
        view = etree.fromstring(self.env.ref("zugfolge_admin.view_zugfolge_demand_data_form").arch_db.encode())
        self.assertEqual(len(view.xpath("//field[@name='settlement_ids']/list[@editable='bottom']")), 1)
        self.assertEqual(len(view.xpath("//field[@name='allocation_ids']/list[@editable='bottom']")), 1)
        self.assertEqual(len(view.xpath("//field[@name='connection_ids']/list[@editable='bottom']")), 1)
        self.assertEqual([button.get("name") for button in view.xpath("//header/button")], ["action_import"])
        self.assertTrue(self.env["zugfolge.demand.station"].fields_get(["demand_class"])["demand_class"]["readonly"])

    def test_transport_refreshes_state_after_an_inflight_final_result(self):
        event = self.data.event_ids[:1]
        self.assertEqual(event.state, "queued")
        result = {"baseReleaseId": self.data.base_release_id, "sourceRevision": event.source_revision, "outcome": "accepted"}

        def deliver_result_to_database(*_args):
            # Emulate a receiver's committed row change outside this ORM cache.
            # The transport still holds the cached pre-request queued value.
            self.cr.execute("UPDATE zugfolge_demand_data_event SET state = 'accepted', result_json = %s::jsonb WHERE id = %s", (json.dumps(result), event.id))

        with patch.object(module, "dispatch_signed_game_command", side_effect=deliver_result_to_database):
            event._dispatch()
        self.assertEqual(event.state, "accepted")
        self.assertEqual(event.result_json, result)
        with self.assertRaises(ValidationError), self.cr.savepoint():
            event._apply_game_result({**result, "outcome": "rejected"})
