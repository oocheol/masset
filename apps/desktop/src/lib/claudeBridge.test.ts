import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const mocks=vi.hoisted(()=>({invoke:vi.fn(),browserCommand:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke,convertFileSrc:vi.fn()}));
vi.mock('@tauri-apps/plugin-dialog',()=>({open:vi.fn()}));
vi.mock('./browser',()=>({browserCommand:mocks.browserCommand,bootstrapBrowser:vi.fn(),getBrowserArtifactUrl:vi.fn(),importBrowserFiles:vi.fn()}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();vi.stubGlobal('window',{});});
afterEach(()=>vi.unstubAllGlobals());

describe('Claude bridge transmission boundary',()=>{
  it('returns an unavailable browser status without a native or browser command',async()=>{
    const bridge=await import('./bridge');
    const status=await bridge.claudeStatus();
    expect(status).toMatchObject({planningAvailable:false,generationAttempted:false,authentication:'unavailable'});
    expect(mocks.invoke).not.toHaveBeenCalled();expect(mocks.browserCommand).not.toHaveBeenCalled();
  });
  it('cannot submit a plan or cancel a provider request in browser mode',async()=>{
    const bridge=await import('./bridge');
    await expect(bridge.claudePlan({brief:'Workshop props',artDirection:'Low-poly',assetCount:3,transmissionApproved:true})).rejects.toThrow();
    await expect(bridge.claudeCancel()).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();expect(mocks.browserCommand).not.toHaveBeenCalled();
  });
  it('sends only an explicit status action for a native connection check',async()=>{
    vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});
    mocks.invoke.mockResolvedValue({planningAvailable:false,generationAttempted:false});
    const bridge=await import('./bridge');await bridge.claudeStatus();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('workspace_command',{request:{action:'claude_status'}});
  });
  it('keeps the Claude action fixed and preserves the creator transmission flag for native validation',async()=>{
    vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});mocks.invoke.mockResolvedValue({});
    const bridge=await import('./bridge');
    const input={action:'generate',brief:'Workshop props',artDirection:'Low-poly',assetCount:3,transmissionApproved:false};
    await bridge.claudePlan(input);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('workspace_command',{request:{...input,action:'claude_plan'}});
    expect(mocks.browserCommand).not.toHaveBeenCalled();
  });
});
