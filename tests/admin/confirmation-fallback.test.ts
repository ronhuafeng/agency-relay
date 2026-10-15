/** @vitest-environment jsdom */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { ConfirmationFallback } from '../../src/admin/ui/fields';

afterEach(() => document.body.replaceChildren());

// Native validity must require explicit confirmation before enhancement.
it('keeps native submission invalid until the confirmation is checked', () => {
  document.body.innerHTML = renderToStaticMarkup(createElement('form', null,
    createElement(ConfirmationFallback, {message:'撤销此密钥后不能恢复。'})));
  const form = document.querySelector('form')!;
  const confirmation = form.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(form.checkValidity()).toBe(false);
  expect(form.textContent).toContain('撤销此密钥后不能恢复。');
  confirmation.checked = true;
  expect(form.checkValidity()).toBe(true);
  confirmation.checked = false;
  expect(form.checkValidity()).toBe(false);
});
