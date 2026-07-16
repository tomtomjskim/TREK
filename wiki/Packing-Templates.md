# Packing Templates

Reuse packing lists across trips using pre-built templates.

Packing templates are currently instance-wide shared templates. Administrators create and manage them; users with `packing_edit` permission can apply them to trips. Personal templates are not available yet.

<!-- TODO: screenshot: packing template list with categories and items -->

![Packing Templates](assets/PackingTemplate.png)

## Applying a template

In the Packing Lists panel, click the **Apply Template** button (shown with a package icon in the toolbar). A dropdown lists all available templates, each showing its name and item count. Click a template to apply it.

Applying a template copies all categories and items from the template into the current trip's packing list — existing items are not removed. Items are inserted with the same category names as defined in the template, so they appear alongside any existing items that share the same category name.

Requires the `packing_edit` permission.

The Apply Template button only appears when at least one template exists and you have edit permission.

## Managing shared templates

Only administrators can create, edit, and delete the shared templates in [Admin-Packing-Templates](Admin-Packing-Templates). Each template has a three-level structure: template → categories → items.

There is currently no **Save as template** action for regular users. Personal packing templates are planned but remain disabled until owner-scoped API and UI protections are complete.

## See also

- [Packing-Lists](Packing-Lists)
- [Admin-Packing-Templates](Admin-Packing-Templates)
