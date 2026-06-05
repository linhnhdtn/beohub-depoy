document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.matches('[data-confirm-deploy]')) {
    return;
  }

  const data = new FormData(form);
  const project = data.get('projectId');
  const branch = data.get('branch');

  if (!window.confirm(`Start deploy for ${project}:${branch}?`)) {
    event.preventDefault();
  }
});

if (document.querySelector('.status.large.running')) {
  window.setTimeout(() => {
    window.location.reload();
  }, 3000);
}
