// FE-MOB-APKG-001 to FE-MOB-APKG-028
import { describe, it, expect, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render, screen, fireEvent, waitFor, within } from '../../../helpers/render';
import { server } from '../../../helpers/msw/server';
import { resetAllStores } from '../../../helpers/store';
import { ToastContainer } from '../../../../src/components/shared/Toast';
import MAdminPackingTemplateManager from '../../../../src/mobile/screens/admin/MAdminPackingTemplateManager';

const tmpl1 = { id: 1, name: 'Beach Trip', item_count: 5, category_count: 2, created_by_name: 'admin' };
const tmpl2 = { id: 2, name: 'City Break', item_count: 3, category_count: 1, created_by_name: 'admin' };

const cat1 = { id: 10, template_id: 1, name: 'Clothing', sort_order: 0 };
const item1 = { id: 100, category_id: 10, name: 'T-shirt', sort_order: 0 };
const item2 = { id: 101, category_id: 10, name: 'Shorts', sort_order: 1 };

function list(templates: unknown[]) {
  return http.get('/api/admin/packing-templates', () => HttpResponse.json({ templates }));
}

function detail(id: number, categories: unknown[], items: unknown[]) {
  return http.get(`/api/admin/packing-templates/${id}`, () => HttpResponse.json({ categories, items }));
}

function renderManager() {
  return render(<><ToastContainer /><MAdminPackingTemplateManager /></>);
}

// Template rows nest the name two levels below the row that holds the icon buttons.
function templateRow(name: string): HTMLElement {
  return screen.getByText(name).parentElement!.parentElement as HTMLElement;
}

function categoryHeader(name: string): HTMLElement {
  return screen.getByText(name).closest('div') as HTMLElement;
}

function itemRow(name: string): HTMLElement {
  return screen.getByText(name).closest('div') as HTMLElement;
}

beforeEach(() => {
  resetAllStores();
});

describe('MAdminPackingTemplateManager', () => {
  it('FE-MOB-APKG-030: rapid template, category and item gestures issue one create request each', async () => {
    const user = userEvent.setup();
    let templateCalls = 0;
    let categoryCalls = 0;
    let itemCalls = 0;
    let releaseTemplate!: () => void;
    let releaseCategory!: () => void;
    let releaseItem!: () => void;
    const templateGate = new Promise<void>(resolve => { releaseTemplate = resolve; });
    const categoryGate = new Promise<void>(resolve => { releaseCategory = resolve; });
    const itemGate = new Promise<void>(resolve => { releaseItem = resolve; });
    server.use(
      list([tmpl1]),
      http.post('/api/admin/packing-templates', async () => {
        templateCalls += 1;
        await templateGate;
        return HttpResponse.json({ template: { id: 3, name: 'Work', created_by_name: 'admin' } });
      }),
      detail(1, [cat1], []),
      http.post('/api/admin/packing-templates/1/categories', async () => {
        categoryCalls += 1;
        await categoryGate;
        return HttpResponse.json({ category: { id: 20, template_id: 1, name: 'Electronics', sort_order: 1 } });
      }),
      http.post('/api/admin/packing-templates/1/categories/10/items', async () => {
        itemCalls += 1;
        await itemGate;
        return HttpResponse.json({ item: { id: 102, category_id: 10, name: 'Sandals', sort_order: 2 } });
      }),
    );
    renderManager();

    await user.click(screen.getByRole('button', { name: 'New Template' }));
    const templateInput = screen.getByPlaceholderText('Template name (e.g. Beach Holiday)');
    await user.type(templateInput, 'Work');
    await user.keyboard('{Enter}{Enter}');
    expect(templateCalls).toBe(1);
    releaseTemplate();
    await screen.findByText('Work');

    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    const categoryInput = screen.getByPlaceholderText('Category name (e.g. Clothing)');
    await user.type(categoryInput, 'Electronics');
    await user.keyboard('{Enter}{Enter}');
    expect(categoryCalls).toBe(1);
    releaseCategory();
    await screen.findByText('Electronics');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Item name' }));
    const itemInput = screen.getByPlaceholderText('Item name');
    await user.type(itemInput, 'Sandals');
    await user.keyboard('{Enter}{Enter}');
    expect(itemCalls).toBe(1);
    releaseItem();
    await screen.findByText('Sandals');
  });

  it('FE-MOB-APKG-031: composing, legacy IME and repeated Enter never submit', async () => {
    const user = userEvent.setup();
    let postCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    server.use(
      list([]),
      http.post('/api/admin/packing-templates', async () => {
        postCalls += 1;
        await gate;
        return HttpResponse.json({ template: { id: 3, name: '한국어', created_by_name: 'admin' } });
      }),
    );
    renderManager();
    await user.click(screen.getByRole('button', { name: 'New Template' }));
    const input = screen.getByPlaceholderText('Template name (e.g. Beach Holiday)');
    await user.type(input, '한국어');

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    expect(postCalls).toBe(0);

    await user.keyboard('{Enter}');
    expect(postCalls).toBe(1);
    release();
    await screen.findByText('한국어');
  });

  it('FE-MOB-APKG-032: Enter followed by rename blur commits a template and category once', async () => {
    const user = userEvent.setup();
    let templateCalls = 0;
    let categoryCalls = 0;
    let releaseTemplate!: () => void;
    let releaseCategory!: () => void;
    const templateGate = new Promise<void>(resolve => { releaseTemplate = resolve; });
    const categoryGate = new Promise<void>(resolve => { releaseCategory = resolve; });
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.put('/api/admin/packing-templates/1', async () => {
        templateCalls += 1;
        await templateGate;
        return HttpResponse.json({ success: true });
      }),
      http.put('/api/admin/packing-templates/1/categories/10', async () => {
        categoryCalls += 1;
        await categoryGate;
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(within(templateRow('Beach Trip')).getByRole('button', { name: 'Edit' }));
    const templateInput = screen.getByDisplayValue('Beach Trip');
    await user.clear(templateInput);
    await user.type(templateInput, 'Summer Packing');
    await user.keyboard('{Enter}');
    fireEvent.blur(templateInput);
    expect(templateCalls).toBe(1);
    releaseTemplate();
    await screen.findByText('Summer Packing');

    await user.click(screen.getByText('Summer Packing'));
    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Edit' }));
    const categoryInput = screen.getByDisplayValue('Clothing');
    await user.clear(categoryInput);
    await user.type(categoryInput, 'Shoes');
    await user.keyboard('{Enter}');
    fireEvent.blur(categoryInput);
    expect(categoryCalls).toBe(1);
    releaseCategory();
    await screen.findByText('Shoes');
  });

  it('FE-MOB-APKG-033: an older detail response cannot overwrite the newer template', async () => {
    const user = userEvent.setup();
    let resolveA!: () => void;
    const aGate = new Promise<void>(resolve => { resolveA = resolve; });
    server.use(
      list([tmpl1, tmpl2]),
      http.get('/api/admin/packing-templates/1', async () => {
        await aGate;
        return HttpResponse.json({ categories: [{ ...cat1, name: 'A category' }], items: [] });
      }),
      detail(2, [{ id: 20, template_id: 2, name: 'B category', sort_order: 0 }], []),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    fireEvent.click(screen.getByText('City Break'));
    await screen.findByText('B category');

    resolveA();
    await waitFor(() => expect(screen.getByText('B category')).toBeInTheDocument());
    expect(screen.queryByText('A category')).not.toBeInTheDocument();
  });

  it('FE-MOB-APKG-034: a pending template-A mutation cannot append into template B', async () => {
    const user = userEvent.setup();
    let resolveAdd!: () => void;
    let addCalls = 0;
    const addGate = new Promise<void>(resolve => { resolveAdd = resolve; });
    server.use(
      list([tmpl1, tmpl2]),
      detail(1, [cat1], []),
      detail(2, [{ id: 20, template_id: 2, name: 'B category', sort_order: 0 }], []),
      http.post('/api/admin/packing-templates/1/categories', async () => {
        addCalls += 1;
        await addGate;
        return HttpResponse.json({ category: { id: 21, template_id: 1, name: 'A only', sort_order: 1 } });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.type(screen.getByPlaceholderText('Category name (e.g. Clothing)'), 'A only');
    await user.keyboard('{Enter}');
    expect(addCalls).toBe(1);

    await user.click(screen.getByText('City Break'));
    await screen.findByText('B category');
    resolveAdd();
    await waitFor(() => expect(screen.getByText('B category')).toBeInTheDocument());
    expect(screen.queryByText('A only')).not.toBeInTheDocument();
  });

  it('FE-MOB-APKG-035: one template serializes nested writes and disables the other controls', async () => {
    const user = userEvent.setup();
    let categoryCalls = 0;
    let itemCalls = 0;
    let releaseCategory!: () => void;
    const categoryGate = new Promise<void>(resolve => { releaseCategory = resolve; });
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.post('/api/admin/packing-templates/1/categories', async () => {
        categoryCalls += 1;
        await categoryGate;
        return HttpResponse.json({ category: { id: 20, template_id: 1, name: 'Electronics', sort_order: 1 } });
      }),
      http.post('/api/admin/packing-templates/1/categories/10/items', () => {
        itemCalls += 1;
        return HttpResponse.json({ item: { id: 102, category_id: 10, name: 'Sandals', sort_order: 2 } });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    const categoryInput = screen.getByPlaceholderText('Category name (e.g. Clothing)');
    await user.type(categoryInput, 'Electronics');
    await user.keyboard('{Enter}');
    expect(categoryCalls).toBe(1);

    const addItemButton = within(categoryHeader('Clothing')).getByRole('button', { name: 'Item name' });
    expect(addItemButton).toBeDisabled();
    await user.click(addItemButton);
    expect(itemCalls).toBe(0);
    releaseCategory();
  });

  it('FE-MOB-APKG-036: reopening after a nested mutation refreshes authoritative detail and counts', async () => {
    const user = userEvent.setup();
    let detailCalls = 0;
    let releaseAdd!: () => void;
    const addGate = new Promise<void>(resolve => { releaseAdd = resolve; });
    const authoritativeCategory = { id: 20, template_id: 1, name: 'Server category', sort_order: 0 };
    server.use(
      list([tmpl1]),
      http.get('/api/admin/packing-templates/1', () => {
        detailCalls += 1;
        return HttpResponse.json({
          categories: detailCalls >= 3 ? [authoritativeCategory] : [],
          items: [],
        });
      }),
      http.post('/api/admin/packing-templates/1/categories', async () => {
        await addGate;
        return HttpResponse.json({ category: { ...authoritativeCategory } });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    const categoryInput = screen.getByPlaceholderText('Category name (e.g. Clothing)');
    await user.type(categoryInput, 'Server category');
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    await user.click(screen.getByText('Beach Trip'));
    await waitFor(() => expect(detailCalls).toBe(2));

    releaseAdd();
    await screen.findByText('Server category');
    expect(detailCalls).toBe(3);
    expect(screen.getByText('1 categories · 0 items')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-001: shows the spinner while templates load, then the empty state', async () => {
    server.use(
      http.get('/api/admin/packing-templates', async () => {
        await new Promise(r => setTimeout(r, 60));
        return HttpResponse.json({ templates: [] });
      }),
    );
    renderManager();

    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.getByText('Packing Templates')).toBeInTheDocument();
    expect(screen.getByText('Create reusable packing lists for your trips')).toBeInTheDocument();

    await screen.findByText('No templates created yet');
    expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
  });

  it('FE-MOB-APKG-002: renders each template with its category and item counts', async () => {
    server.use(list([tmpl1, tmpl2]));
    renderManager();

    await screen.findByText('Beach Trip');
    expect(screen.getByText('City Break')).toBeInTheDocument();
    expect(screen.getByText('2 categories · 5 items')).toBeInTheDocument();
    expect(screen.getByText('1 categories · 3 items')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-003: a failing list request surfaces the load error toast', async () => {
    server.use(http.get('/api/admin/packing-templates', () => HttpResponse.error()));
    renderManager();

    await screen.findByText('Failed to load templates');
    expect(screen.getByText('No templates created yet')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-004: creating a template prepends it, expands it and toasts', async () => {
    const user = userEvent.setup();
    let posted: unknown = null;
    server.use(
      list([tmpl1]),
      http.post('/api/admin/packing-templates', async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ template: { id: 99, name: 'Winter Trip' } });
      }),
      detail(99, [], []),
    );
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(screen.getByRole('button', { name: 'New Template' }));
    await user.type(screen.getByPlaceholderText('Template name (e.g. Beach Holiday)'), '  Winter Trip  {Enter}');

    await waitFor(() => expect(posted).toEqual({ name: 'Winter Trip' }));
    await screen.findByText('Template created');
    expect(screen.getByText('0 categories · 0 items')).toBeInTheDocument();
    // The new template is expanded right away, so its category editor is visible.
    expect(screen.getByRole('button', { name: 'Add category' })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Template name (e.g. Beach Holiday)')).not.toBeInTheDocument();
  });

  it('FE-MOB-APKG-005: saving a blank template name is a no-op', async () => {
    const user = userEvent.setup();
    let postCalls = 0;
    server.use(
      http.post('/api/admin/packing-templates', () => {
        postCalls += 1;
        return HttpResponse.json({ template: { id: 5, name: '' } });
      }),
    );
    renderManager();
    await screen.findByText('No templates created yet');

    await user.click(screen.getByRole('button', { name: 'New Template' }));
    await user.type(screen.getByPlaceholderText('Template name (e.g. Beach Holiday)'), '   ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(postCalls).toBe(0);
    expect(screen.getByPlaceholderText('Template name (e.g. Beach Holiday)')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-006: a failing create shows the create error toast', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/admin/packing-templates', () => HttpResponse.json({ error: 'nope' }, { status: 500 })),
    );
    renderManager();
    await screen.findByText('No templates created yet');

    await user.click(screen.getByRole('button', { name: 'New Template' }));
    await user.type(screen.getByPlaceholderText('Template name (e.g. Beach Holiday)'), 'Boom{Enter}');

    expect(await screen.findByText('Failed to create template')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-007: Escape and the cancel button both close the create field', async () => {
    const user = userEvent.setup();
    renderManager();
    await screen.findByText('No templates created yet');

    await user.click(screen.getByRole('button', { name: 'New Template' }));
    await user.type(screen.getByPlaceholderText('Template name (e.g. Beach Holiday)'), 'Draft{Escape}');
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Template name (e.g. Beach Holiday)')).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'New Template' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Template name (e.g. Beach Holiday)')).not.toBeInTheDocument(),
    );
  });

  it('FE-MOB-APKG-008: expanding loads categories and items, collapsing hides them again', async () => {
    const user = userEvent.setup();
    server.use(list([tmpl1]), detail(1, [cat1], [item1, item2]));
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(screen.getByRole('button', { name: 'Expand' }));
    await screen.findByText('Clothing');
    expect(screen.getByText('T-shirt')).toBeInTheDocument();
    expect(screen.getByText('Shorts')).toBeInTheDocument();
    // The category header counts its items.
    expect(within(categoryHeader('Clothing')).getByText('2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse' }));
    await waitFor(() => expect(screen.queryByText('Clothing')).not.toBeInTheDocument());
    expect(screen.queryByText('T-shirt')).not.toBeInTheDocument();
  });

  it('FE-MOB-APKG-009: a failing detail request toasts and leaves the template empty', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      http.get('/api/admin/packing-templates/1', () => HttpResponse.error()),
    );
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(screen.getByText('Beach Trip'));

    await screen.findByText('Failed to load templates');
    expect(screen.getByRole('button', { name: 'Add category' })).toBeInTheDocument();
  });

  it('FE-MOB-APKG-010: deleting a template removes it and collapses the expanded panel', async () => {
    const user = userEvent.setup();
    let deleted = false;
    server.use(
      list([tmpl1, tmpl2]),
      detail(1, [cat1], [item1]),
      http.delete('/api/admin/packing-templates/1', () => {
        deleted = true;
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(templateRow('Beach Trip')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(screen.queryByText('Beach Trip')).not.toBeInTheDocument());
    expect(screen.queryByText('Clothing')).not.toBeInTheDocument();
    expect(screen.getByText('City Break')).toBeInTheDocument();
    await screen.findByText('Template deleted');
  });

  it('FE-MOB-APKG-011: a failing template delete keeps the row and toasts', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      http.delete('/api/admin/packing-templates/1', () => HttpResponse.error()),
    );
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(within(templateRow('Beach Trip')).getByRole('button', { name: 'Delete' }));

    await screen.findByText('Failed to delete template');
    expect(screen.getByText('Beach Trip')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-012: renaming a template persists the trimmed name', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      list([tmpl1]),
      http.put('/api/admin/packing-templates/1', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(within(templateRow('Beach Trip')).getByRole('button', { name: 'Edit' }));
    const input = screen.getByDisplayValue('Beach Trip');
    await user.clear(input);
    await user.type(input, 'Summer Packing{Enter}');

    await waitFor(() => expect(body).toEqual({ name: 'Summer Packing' }));
    await screen.findByText('Summer Packing');
  });

  it('FE-MOB-APKG-013: blurring an emptied template name cancels the rename', async () => {
    const user = userEvent.setup();
    let putCalls = 0;
    server.use(
      list([tmpl1]),
      http.put('/api/admin/packing-templates/1', () => {
        putCalls += 1;
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(within(templateRow('Beach Trip')).getByRole('button', { name: 'Edit' }));
    const input = screen.getByDisplayValue('Beach Trip');
    await user.clear(input);
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText('Beach Trip')).toBeInTheDocument());
    expect(putCalls).toBe(0);
  });

  it('FE-MOB-APKG-014: Escape cancels the rename and a failing rename toasts', async () => {
    const user = userEvent.setup();
    let putCalls = 0;
    server.use(
      list([tmpl1]),
      http.put('/api/admin/packing-templates/1', () => {
        putCalls += 1;
        return HttpResponse.error();
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');

    await user.click(within(templateRow('Beach Trip')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByDisplayValue('Beach Trip'), '{Escape}');
    await waitFor(() => expect(screen.queryByDisplayValue('Beach Trip')).not.toBeInTheDocument());
    expect(putCalls).toBe(0);

    await user.click(within(templateRow('Beach Trip')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByDisplayValue('Beach Trip'), ' 2{Enter}');
    await screen.findByText('Failed to save');
    expect(putCalls).toBe(1);
  });

  it('FE-MOB-APKG-015: adding a category appends it to the expanded template', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      list([tmpl1]),
      detail(1, [], []),
      http.post('/api/admin/packing-templates/1/categories', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ category: { id: 20, template_id: 1, name: 'Electronics', sort_order: 1 } });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.type(screen.getByPlaceholderText('Category name (e.g. Clothing)'), 'Electronics{Enter}');

    await waitFor(() => expect(body).toEqual({ name: 'Electronics' }));
    await screen.findByText('Electronics');
    expect(screen.getByText('3 categories · 5 items')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Category name (e.g. Clothing)')).not.toBeInTheDocument();
  });

  it('FE-MOB-APKG-016: a blank category name is ignored and Escape closes the field', async () => {
    const user = userEvent.setup();
    let postCalls = 0;
    server.use(
      list([tmpl1]),
      detail(1, [], []),
      http.post('/api/admin/packing-templates/1/categories', () => {
        postCalls += 1;
        return HttpResponse.json({ category: { id: 20, template_id: 1, name: 'x', sort_order: 1 } });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(postCalls).toBe(0);

    await user.type(screen.getByPlaceholderText('Category name (e.g. Clothing)'), 'Draft{Escape}');
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Category name (e.g. Clothing)')).not.toBeInTheDocument(),
    );

    // Reopening starts from an empty field and the cancel button closes it too.
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    expect(screen.getByPlaceholderText('Category name (e.g. Clothing)')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('Category name (e.g. Clothing)')).not.toBeInTheDocument(),
    );
    expect(postCalls).toBe(0);
  });

  it('FE-MOB-APKG-017: a failing category create toasts the save error', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      detail(1, [], []),
      http.post('/api/admin/packing-templates/1/categories', () => HttpResponse.error()),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.type(screen.getByPlaceholderText('Category name (e.g. Clothing)'), 'Electronics{Enter}');

    expect(await screen.findByText('Failed to save')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-018: renaming a category updates its header', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.put('/api/admin/packing-templates/1/categories/10', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Edit' }));
    const input = screen.getByDisplayValue('Clothing');
    await user.clear(input);
    await user.type(input, 'Shoes{Enter}');

    await waitFor(() => expect(body).toEqual({ name: 'Shoes' }));
    await screen.findByText('Shoes');
  });

  it('FE-MOB-APKG-019: Escape and an emptied field both cancel the category rename', async () => {
    const user = userEvent.setup();
    let putCalls = 0;
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.put('/api/admin/packing-templates/1/categories/10', () => {
        putCalls += 1;
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByDisplayValue('Clothing'), '{Escape}');
    await waitFor(() => expect(screen.queryByDisplayValue('Clothing')).not.toBeInTheDocument());

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Edit' }));
    const input = screen.getByDisplayValue('Clothing');
    await user.clear(input);
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText('Clothing')).toBeInTheDocument());
    expect(putCalls).toBe(0);
  });

  it('FE-MOB-APKG-029: a failing category rename toasts and keeps the old name', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.put('/api/admin/packing-templates/1/categories/10', () => HttpResponse.error()),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByDisplayValue('Clothing'), ' XL{Enter}');

    await screen.findByText('Failed to save');
    expect(screen.getByDisplayValue('Clothing XL')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-020: deleting a category drops its items too', async () => {
    const user = userEvent.setup();
    let deleted = false;
    server.use(
      list([tmpl1]),
      detail(1, [cat1], [item1, item2]),
      http.delete('/api/admin/packing-templates/1/categories/10', () => {
        deleted = true;
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(screen.queryByText('Clothing')).not.toBeInTheDocument());
    expect(screen.queryByText('T-shirt')).not.toBeInTheDocument();
    expect(screen.queryByText('Shorts')).not.toBeInTheDocument();
    expect(screen.getByText('1 categories · 3 items')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-021: a failing category delete toasts and keeps the category', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      detail(1, [cat1], [item1]),
      http.delete('/api/admin/packing-templates/1/categories/10', () => HttpResponse.error()),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Delete' }));

    await screen.findByText('Failed to delete');
    expect(screen.getByText('Clothing')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-022: adding an item posts to the category and clears the field', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.post('/api/admin/packing-templates/1/categories/10/items', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ item: { id: 102, category_id: 10, name: 'Sandals', sort_order: 2 } });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Item name' }));
    await user.type(screen.getByPlaceholderText('Item name'), 'Sandals{Enter}');

    await waitFor(() => expect(body).toEqual({ name: 'Sandals' }));
    await screen.findByText('Sandals');
    expect(screen.getByText('2 categories · 6 items')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Item name')).toHaveValue('');
  });

  it('FE-MOB-APKG-023: the add-item confirm button is disabled while the field is empty', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.post('/api/admin/packing-templates/1/categories/10/items', () =>
        HttpResponse.json({ item: { id: 103, category_id: 10, name: 'Hat', sort_order: 3 } }),
      ),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Item name' }));
    const addRow = screen.getByPlaceholderText('Item name').closest('div') as HTMLElement;
    const confirm = within(addRow).getByRole('button', { name: 'Item name' });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Item name'), 'Hat');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await screen.findByText('Hat');
  });

  it('FE-MOB-APKG-024: Escape and cancel close the add-item field without posting', async () => {
    const user = userEvent.setup();
    let postCalls = 0;
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.post('/api/admin/packing-templates/1/categories/10/items', () => {
        postCalls += 1;
        return HttpResponse.json({ item: { id: 104, category_id: 10, name: 'x', sort_order: 4 } });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    const plus = within(categoryHeader('Clothing')).getByRole('button', { name: 'Item name' });
    await user.click(plus);
    await user.type(screen.getByPlaceholderText('Item name'), 'Draft{Escape}');
    await waitFor(() => expect(screen.queryByPlaceholderText('Item name')).not.toBeInTheDocument());

    await user.click(plus);
    await user.type(screen.getByPlaceholderText('Item name'), 'Draft');
    const addRow = screen.getByPlaceholderText('Item name').closest('div') as HTMLElement;
    await user.click(within(addRow).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByPlaceholderText('Item name')).not.toBeInTheDocument());

    // The plus button toggles the field shut when pressed a second time.
    await user.click(plus);
    expect(screen.getByPlaceholderText('Item name')).toBeInTheDocument();
    await user.click(plus);
    await waitFor(() => expect(screen.queryByPlaceholderText('Item name')).not.toBeInTheDocument());
    expect(postCalls).toBe(0);
  });

  it('FE-MOB-APKG-025: a failing item create toasts the save error', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      detail(1, [cat1], []),
      http.post('/api/admin/packing-templates/1/categories/10/items', () => HttpResponse.error()),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('Clothing');

    await user.click(within(categoryHeader('Clothing')).getByRole('button', { name: 'Item name' }));
    await user.type(screen.getByPlaceholderText('Item name'), 'Sandals{Enter}');

    expect(await screen.findByText('Failed to save')).toBeInTheDocument();
  });

  it('FE-MOB-APKG-026: renaming an item persists via the save button', async () => {
    const user = userEvent.setup();
    let body: unknown = null;
    server.use(
      list([tmpl1]),
      detail(1, [cat1], [item1]),
      http.put('/api/admin/packing-templates/1/items/100', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ success: true });
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('T-shirt');

    await user.click(within(itemRow('T-shirt')).getByRole('button', { name: 'Edit' }));
    const input = screen.getByDisplayValue('T-shirt');
    await user.clear(input);
    await user.type(input, 'Tank Top');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(body).toEqual({ name: 'Tank Top' }));
    await screen.findByText('Tank Top');
  });

  it('FE-MOB-APKG-027: item rename cancels on Escape, on cancel and on an empty name', async () => {
    const user = userEvent.setup();
    let putCalls = 0;
    server.use(
      list([tmpl1]),
      detail(1, [cat1], [item1]),
      http.put('/api/admin/packing-templates/1/items/100', () => {
        putCalls += 1;
        return HttpResponse.error();
      }),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('T-shirt');

    await user.click(within(itemRow('T-shirt')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByDisplayValue('T-shirt'), '{Escape}');
    await waitFor(() => expect(screen.queryByDisplayValue('T-shirt')).not.toBeInTheDocument());

    await user.click(within(itemRow('T-shirt')).getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByDisplayValue('T-shirt')).not.toBeInTheDocument());

    await user.click(within(itemRow('T-shirt')).getByRole('button', { name: 'Edit' }));
    const input = screen.getByDisplayValue('T-shirt');
    await user.clear(input);
    await user.type(input, '{Enter}');
    await waitFor(() => expect(screen.getByText('T-shirt')).toBeInTheDocument());
    expect(putCalls).toBe(0);

    // A rejected rename keeps the old name and toasts.
    await user.click(within(itemRow('T-shirt')).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByDisplayValue('T-shirt'), ' XL{Enter}');
    await screen.findByText('Failed to save');
    expect(putCalls).toBe(1);
  });

  it('FE-MOB-APKG-028: deleting an item removes only that item, failures toast', async () => {
    const user = userEvent.setup();
    server.use(
      list([tmpl1]),
      detail(1, [cat1], [item1, item2]),
      http.delete('/api/admin/packing-templates/1/items/100', () => HttpResponse.json({ success: true })),
      http.delete('/api/admin/packing-templates/1/items/101', () => HttpResponse.error()),
    );
    renderManager();
    await screen.findByText('Beach Trip');
    await user.click(screen.getByText('Beach Trip'));
    await screen.findByText('T-shirt');

    await user.click(within(itemRow('T-shirt')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText('T-shirt')).not.toBeInTheDocument());
    expect(screen.getByText('Shorts')).toBeInTheDocument();
    expect(screen.getByText('2 categories · 4 items')).toBeInTheDocument();

    await user.click(within(itemRow('Shorts')).getByRole('button', { name: 'Delete' }));
    await screen.findByText('Failed to delete');
    expect(screen.getByText('Shorts')).toBeInTheDocument();
  });
});
