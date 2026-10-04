(async () => {
  if (window.__ASSET_UPDATE_QA_RUNNING__) return;
  window.__ASSET_UPDATE_QA_RUNNING__ = true;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const command = request => window.__TAURI__.core.invoke('workspace_command', {request});
  const checkpoint = (phase, report) => window.__TAURI__.core.invoke('update_qa_checkpoint', {phase, report});
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async (label, predicate, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(200); }
    throw new Error(`${label} timed out`);
  };
  const report = {externalProviderCalls: 0};
  const originalInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = function(name, args, ...rest) {
    if (name === 'workspace_command' && /^(provider_|codex_|generate)/.test(args?.request?.action ?? '')) {
      report.externalProviderCalls++;
      return Promise.reject(new Error('Update QA refuses external provider operations'));
    }
    return Reflect.apply(originalInvoke, this, [name, args, ...rest]);
  };
  try {
    await wait('Rendered fixture images', () => [...document.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth > 0).length >= 8);
    report.decodedImages = [...document.querySelectorAll('img')].filter(img => img.complete && img.naturalWidth > 0).length;
    const status = await command({action:'update_status'});
    check(status.supported, 'Mac updater is unavailable');
    if (status.currentVersion === window.__ASSET_UPDATE_QA__.toVersion) {
      await checkpoint('after', report);
      return;
    }
    check(status.currentVersion === window.__ASSET_UPDATE_QA__.fromVersion, 'Wrong starting app');
    await wait('Signed GitHub candidate update', async () => {
      const next = await command({action:'update_status'});
      if (next.state === 'error') throw new Error(next.message);
      return next.state === 'available' && next.latestVersion === window.__ASSET_UPDATE_QA__.toVersion;
    });
    const entry = await wait('Update entry', () => document.querySelector('.app-update-alert') ?? document.querySelector('button[title="앱 업데이트"]'));
    entry.click();
    const panel = await wait('Native update panel', () => document.querySelector('.app-update-panel'));
    const install = [...panel.querySelectorAll('button')].find(button => button.textContent.trim() === '지금 업데이트');
    const approval = panel.querySelector('.approval input');
    check(install && approval, 'Update approval controls missing');
    report.installDisabledBeforeApproval = install.disabled;
    check(install.disabled, 'Unapproved install enabled');
    approval.click();
    await wait('Approved install enabled', () => !install.disabled, 5000);
    report.installEnabledAfterApproval = !install.disabled;
    report.reviewedVersion = window.__ASSET_UPDATE_QA__.toVersion;
    await checkpoint('before', report);
    install.click();
    await wait('Install/restart', async () => {
      const next = await command({action:'update_status'});
      if (next.state === 'error') throw new Error(next.message);
      return false;
    }, 300000);
  } catch (error) {
    report.error = String(error);
    await checkpoint('error', report);
  }
})();
