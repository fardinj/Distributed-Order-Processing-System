import { moneyText, statusText } from './format.js';
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity))
    if (child !== undefined && child !== null && child !== false)
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}
export function replace(node, ...children) {
  node.replaceChildren(
    ...children
      .flat(Infinity)
      .filter((child) => child !== null && child !== undefined && child !== false),
  );
}
export const money = (value) =>
  h(
    'span',
    { class: 'money', title: String(value) },
    h('bdi', {}, moneyText(value)),
    h('small', {}, 'ریال'),
  );
export const code = (value) => h('bdi', { class: 'code', dir: 'ltr' }, value ?? '—');
export const badge = (value) =>
  h(
    'span',
    {
      class: `badge ${/FAILED|REVIEW|UNKNOWN|CHANGED|EXPIRED|ATTENTION|PENDING/.test(value) ? 'warn' : ''}`,
    },
    statusText(value),
  );
export const empty = (text) => h('div', { class: 'empty' }, text);
export const button = (label, action, className = 'quiet', attrs = {}) =>
  h(
    'button',
    {
      type: 'button',
      class: className,
      ...attrs,
      onclick: async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        try {
          await action();
        } catch (error) {
          notice(error.message, 'error');
        } finally {
          target.disabled = false;
        }
      },
    },
    label,
  );
export function notice(text, kind = '') {
  const area = document.querySelector('#notice');
  area.className = `notice ${kind}`;
  area.replaceChildren(
    document.createTextNode(text),
    button('بستن', () => {
      area.hidden = true;
    }),
  );
  area.hidden = false;
}
export const heading = (title, description, action) =>
  h(
    'div',
    { class: 'heading' },
    h('div', {}, h('h1', {}, title), h('p', { class: 'muted' }, description)),
    action,
  );
export function field(name, label, value = '', options = {}) {
  const { type = 'text', ...attributes } = options;
  return h(
    'label',
    {},
    label,
    h(type === 'textarea' ? 'textarea' : 'input', {
      name,
      type: type === 'textarea' ? null : type,
      value,
      ...attributes,
    }),
  );
}
export function select(name, label, options, value) {
  const input = h(
    'select',
    { name },
    options.map(([id, text]) => h('option', { value: id }, text)),
  );
  input.value = value ?? options[0][0];
  return h('label', {}, label, input);
}
export const reasonField = () =>
  field('reason', 'دلیل این تغییر', '', {
    type: 'textarea',
    required: true,
    minlength: 5,
    maxlength: 1000,
  });
export function ask(title, fields, action) {
  const dialog = document.querySelector('#action-dialog');
  const form = document.querySelector('#action-form');
  document.querySelector('#dialog-title').textContent = title;
  document.querySelector('#dialog-fields').replaceChildren(...fields);
  document.querySelector('#dialog-error').textContent = '';
  const submit = form.querySelector('[type=submit]');
  submit.disabled = false;
  dialog.oncancel = (event) => {
    if (submit.disabled) event.preventDefault();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      await action(Object.fromEntries(new FormData(form)));
      dialog.close();
    } catch (error) {
      document.querySelector('#dialog-error').textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  };
  document.querySelector('#dialog-cancel').onclick = () => {
    if (!submit.disabled) dialog.close();
  };
  dialog.showModal();
}
export function table(headers, rows) {
  return h(
    'div',
    {
      class: 'table-wrap',
      tabindex: 0,
      role: 'region',
      'aria-label': 'جدول اقلام سفارش؛ برای مشاهده همه ستون‌ها افقی جابه‌جا کنید',
    },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          headers.map((x) => h('th', { scope: 'col' }, x)),
        ),
      ),
      h('tbody', {}, rows),
    ),
  );
}
export const details = (title, data) =>
  h('details', {}, h('summary', {}, title), h('pre', {}, JSON.stringify(data, null, 2)));
