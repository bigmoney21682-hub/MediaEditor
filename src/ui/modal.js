/** Minimal modal helper. `build(body, close)` fills the content; returns { close }. */
export function openModal({ title, wide = false, build, onClose, footer }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `
    <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
      <header><h2>${title}</h2><button class="x" aria-label="Close">×</button></header>
      <div class="content"></div>
    </div>`;
  const modal = back.querySelector('.modal');
  const content = back.querySelector('.content');

  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.(result);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };

  back.querySelector('.x').addEventListener('click', () => close());
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);

  build(content, close);

  if (footer) {
    const f = document.createElement('footer');
    footer(f, close);
    modal.appendChild(f);
  }
  document.getElementById('modal-root').appendChild(back);
  return { close, content, back };
}

/** `<div class="row">` with a label and arbitrary controls. */
export function row(label, ...nodes) {
  const d = document.createElement('div');
  d.className = 'row';
  if (label !== null) {
    const l = document.createElement('label');
    l.textContent = label;
    d.appendChild(l);
  }
  for (const n of nodes) d.appendChild(n);
  return d;
}

export function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

/** Range control that reports its live value. */
export function slider(label, { min, max, step = 1, value, format = (v) => v, onInput }) {
  const input = el('input', { type: 'range', min, max, step, value });
  const val = el('span', { class: 'val' }, format(value));
  input.addEventListener('input', () => {
    val.textContent = format(+input.value);
    onInput(+input.value);
  });
  const r = row(label, input, val);
  r.setValue = (v) => { input.value = v; val.textContent = format(v); };
  return r;
}

export function segmented(options, value, onPick) {
  const wrap = el('div', { class: 'seg' });
  const btns = options.map(([v, label]) => {
    const b = el('button', { type: 'button' }, label);
    b.classList.toggle('active', v === value);
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      onPick(v);
    });
    return b;
  });
  wrap.append(...btns);
  return wrap;
}

export function field(label, ...nodes) {
  return el('div', { class: 'field' }, el('label', {}, label), ...nodes);
}
