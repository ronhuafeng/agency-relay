/** @vitest-environment jsdom */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { ConfirmationFallback } from '../../src/admin/ui/fields';

afterEach(() => document.body.replaceChildren());

// Closing the explanation must never waive native confirmation before the
// runtime takes responsibility. Either native or enhanced styling is allowed.
it('keeps native submission invalid until the collapsed confirmation is checked', () => {
  document.body.innerHTML = renderToStaticMarkup(createElement('form', null,
    createElement(ConfirmationFallback, {message:'撤销此密钥后不能恢复。'})));
  const form = document.querySelector('form')!;
  const disclosure = form.querySelector('details')!;
  const confirmation = form.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  expect(disclosure.open).toBe(false);
  expect(form.checkValidity()).toBe(false);
  disclosure.querySelector('summary')!.click();
  expect(disclosure.open).toBe(true);
  expect(disclosure.textContent).toContain('撤销此密钥后不能恢复。');
  confirmation.checked = true;
  expect(form.checkValidity()).toBe(true);
  disclosure.open = false;
  confirmation.checked = false;
  expect(form.checkValidity()).toBe(false);
});
