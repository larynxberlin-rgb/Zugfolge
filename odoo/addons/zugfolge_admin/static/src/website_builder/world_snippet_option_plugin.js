import { Plugin } from "@html_editor/plugin";
import { BaseOptionComponent } from "@html_builder/core/utils";
import { registry } from "@web/core/registry";

export class ZugfolgeWorldSnippetOption extends BaseOptionComponent {
    static template = "zugfolge_admin.WorldSnippetOption";
    static selector = "[data-zugfolge-worlds]";
}

class ZugfolgeWorldSnippetOptionPlugin extends Plugin {
    static id = "zugfolgeWorldSnippetOption";
    resources = {
        builder_options: [ZugfolgeWorldSnippetOption],
    };
}

registry.category("website-plugins").add(
    ZugfolgeWorldSnippetOptionPlugin.id,
    ZugfolgeWorldSnippetOptionPlugin,
);
