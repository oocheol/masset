(async () => {
  if (window.__ASSET_NATIVE_QA_RUNNING__) return;
  window.__ASSET_NATIVE_QA_RUNNING__ = true;
  const withModel = window.__ASSET_NATIVE_QA__?.withNativeModel === true;
  const state = {domReady:false, decodedImages:0, title:document.title}, restores=[];
  let providerCalls=0,updateNetworkActions=0,gameUiPhase=false,gameUiBaseline=null,gameUiSubmission=null,qualityUiPhase=false,qualityUiSubmission=null;
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const invoke=request=>window.__TAURI__.core.invoke('workspace_command',{request});
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  const wait=async(label,predicate,timeout)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){const value=await predicate();if(value)return value;await sleep(150);}throw new Error(`${label} timed out`);};
  const originalInvoke=window.__TAURI_INTERNALS__.invoke;
  const qaInvoke=function(command,args,...rest){
    const request=args?.request;
    if(command==='workspace_command'&&qualityUiPhase&&request?.action==='quality3d_status')return Promise.resolve({supported:true,installed:true,busy:false,state:'ready',message:'Isolated native UI fixture; reconstruction installation status mocked',stage:'ready',modelId:'stabilityai/TripoSR',modelRevision:'native-ui-mock',device:'cpu',pythonVersion:'native-ui-mock',weightBytes:1677246742,memoryMb:24576,minimumMemoryMb:16384,blenderReady:true});
    if(command==='workspace_command'&&qualityUiPhase&&request?.action==='quality3d'){
      qualityUiSubmission=structuredClone(request);
      return Reflect.apply(originalInvoke,this,[command,{request:{action:'snapshot'}},...rest]);
    }
    if(command==='workspace_command'&&['quality3d_prepare','quality3d_cancel_setup','quality3d'].includes(request?.action))return Promise.reject(new Error('Native UI fixture refuses model downloads and reconstruction'));
    if(command==='workspace_command'&&gameUiPhase&&request?.action==='provider_setup_status')return Promise.resolve({supported:false,state:'ready',runtimeDetected:true,downloadedBytes:0,totalBytes:0,message:'격리된 화면 검사입니다.',manifest:{version:'native-ui-mock',bytes:0,sha256:'',platform:'native-ui-fixture'}});
    if(command==='workspace_command'&&gameUiPhase&&request?.action==='provider_status')return Promise.resolve({available:true,ready:true,authenticated:true,authentication:'chatgpt',reasoningModel:'gpt-6.1-sol',requestedModel:'gpt-image-2',confirmedModel:null,runtimeVersion:'native-ui-mock-no-provider',reason:'Isolated UI fixture; no provider call',checkedAt:new Date().toISOString(),receivedImages:0,rateLimits:[]});
    if(command==='workspace_command'&&gameUiPhase&&request?.action==='plan_assets'){
      const names=['플라스마 소총','레이저 권총','중력 대포','EMP 발사기','광자 검'];
      return Promise.resolve({schemaVersion:1,id:crypto.randomUUID(),projectId:gameUiBaseline.project.id,plannerModel:'gpt-5.5',brief:request.brief,output:'images',mode:'new',spec:gameUiBaseline.project.spec,styleGuide:gameUiBaseline.project.styleGuide,referenceAssetIds:[],references:[],summary:'Native UI fixture: five individually named weapons; provider response mocked.',warnings:[],items:names.map(name=>({id:crypto.randomUUID(),name,kind:'image',prompt:`SINGLE ASSET "${name}": One isolated ${name}.`,purpose:'독립 인벤토리 아이콘',referenceAssetIds:[],targetAssetId:null,modelParameters:null,enabled:true}))});
    }
    if(command==='workspace_command'&&gameUiPhase&&request?.action==='generate_bundle'){
      gameUiSubmission=structuredClone(request);
      return Reflect.apply(originalInvoke,this,[command,{request:{action:'snapshot'}},...rest]);
    }
    if(command==='workspace_command'&&['provider_status','provider_login','generate','plan_assets','generate_bundle','cancel_plan'].includes(request?.action)){providerCalls++;return Promise.reject(new Error('Local native QA refuses provider commands'));}
    if(command==='workspace_command'&&['update_check','update_install'].includes(args?.request?.action)){updateNetworkActions++;return Promise.reject(new Error('Local native QA refuses update network actions'));}
    return Reflect.apply(originalInvoke,this,[command,args,...rest]);
  };
  const previousQaCommand=window.__ASSET_NATIVE_QA_COMMAND__;
  window.__ASSET_NATIVE_QA_COMMAND__=request=>qaInvoke('workspace_command',{request});
  restores.push(()=>{if(previousQaCommand)window.__ASSET_NATIVE_QA_COMMAND__=previousQaCommand;else delete window.__ASSET_NATIVE_QA_COMMAND__;});
  const readGlb=data=>{
    const view=new DataView(data);
    check(data.byteLength>=20&&view.getUint32(0,true)===0x46546c67&&view.getUint32(4,true)===2&&view.getUint32(8,true)===data.byteLength,'Invalid GLB 2 header');
    const size=view.getUint32(12,true);check(view.getUint32(16,true)===0x4e4f534a&&size>0&&20+size<=data.byteLength,'Invalid GLB JSON chunk');
    const json=JSON.parse(new TextDecoder().decode(new Uint8Array(data,20,size)).trim());
    const primitives=(json.meshes??[]).flatMap(mesh=>mesh.primitives??[]);
    let vertices=0,triangles=0;
    for(const primitive of primitives){const position=json.accessors[primitive.attributes.POSITION];vertices+=position.count;triangles+=(primitive.indices==null?position.count:json.accessors[primitive.indices].count)/3;}
    const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
    const multiply=(a,b)=>Array.from({length:16},(_,i)=>[0,1,2,3].reduce((sum,k)=>sum+a[i%4+k*4]*b[k+Math.floor(i/4)*4],0));
    const transform=node=>{
      if(node.matrix)return node.matrix;
      const [x,y,z,w]=node.rotation??[0,0,0,1],[sx,sy,sz]=node.scale??[1,1,1],p=node.translation??[0,0,0];
      const xx=2*x*x,yy=2*y*y,zz=2*z*z,xy=2*x*y,xz=2*x*z,yz=2*y*z,wx=2*w*x,wy=2*w*y,wz=2*w*z;
      return [(1-yy-zz)*sx,(xy+wz)*sx,(xz-wy)*sx,0,(xy-wz)*sy,(1-xx-zz)*sy,(yz+wx)*sy,0,(xz+wy)*sz,(yz-wx)*sz,(1-xx-yy)*sz,0,...p,1];
    };
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],visited=new Set();
    const visit=(index,parent)=>{
      check(!visited.has(index)&&json.nodes?.[index],'Invalid GLB scene graph');visited.add(index);
      const node=json.nodes[index],matrix=multiply(parent,transform(node));
      if(node.mesh!=null)for(const primitive of json.meshes[node.mesh].primitives){
        const accessor=json.accessors[primitive.attributes.POSITION];check(accessor.min?.length===3&&accessor.max?.length===3,'GLB bounds missing');
        for(let mask=0;mask<8;mask++){const point=[0,1,2].map(axis=>(mask>>axis)&1?accessor.max[axis]:accessor.min[axis]);for(let axis=0;axis<3;axis++){const value=matrix[axis]*point[0]+matrix[axis+4]*point[1]+matrix[axis+8]*point[2]+matrix[axis+12];min[axis]=Math.min(min[axis],value);max[axis]=Math.max(max[axis],value);}}
      }
      for(const child of node.children??[])visit(child,matrix);
    };
    for(const index of json.scenes?.[json.scene??0]?.nodes??[])visit(index,identity);
    const dimensions=max.map((value,axis)=>value-min[axis]);check(vertices>0&&triangles>0&&dimensions.every(value=>Number.isFinite(value)&&value>0),'GLB scene geometry invalid');
    return {headerValid:true,meshCount:json.meshes.length,primitiveCount:primitives.length,vertices,triangles,bounds:{min,max,dimensions}};
  };
  try{
    const decoded=await wait('Native DOM/assets',()=>{
      const images=[...document.querySelectorAll('img')];for(const image of images)image.loading='eager';
      const decoded=images.filter(image=>image.complete&&image.naturalWidth>0&&/asset\.localhost|asset:/.test(image.src));
      return document.querySelector('h1')&&document.querySelectorAll('[aria-label="에셋 목록"] img').length>=8&&decoded.length>=8?decoded:null;
    },45000);
    Object.assign(state,{domReady:true,decodedImages:decoded.length,ipcEnvironment:await invoke({action:'environment'}),protocols:[...new Set(decoded.map(image=>new URL(image.src).protocol))]});
    await document.fonts.ready;
    const visibleButtons=[...document.querySelectorAll('button')].filter(button=>button.offsetWidth>0&&button.offsetHeight>0&&button.textContent.trim().length>1);
    const smallButtons=visibleButtons.filter(button=>parseFloat(getComputedStyle(button).fontSize)<14).map(button=>({text:button.textContent.trim().slice(0,60),fontSize:getComputedStyle(button).fontSize}));
    const guide=document.querySelector('.guide-button');check(guide&&!guide.disabled,'Usage guide button unavailable');guide.focus();guide.click();
    await wait('Usage guide',()=>document.querySelector('.dialog-guide .usage-guide'),5000);
    const guideSize=parseFloat(getComputedStyle(document.querySelector('.guide-intro')).fontSize);
    const onboardingButton=[...document.querySelectorAll('.titlebar-actions button')].find(button=>button.textContent.trim()==='구독 연결');
    const guideText=document.querySelector('.usage-guide').textContent;
    state.codexOnboarding={visibleEntry:!!onboardingButton&&!onboardingButton.disabled,
      entryFont:onboardingButton?parseFloat(getComputedStyle(onboardingButton).fontSize):0,
      guideSequence:['Codex 준비','공식 계정 연결','연결 확인'].every(text=>guideText.includes(text)),
      installerInvoked:false,loginInvoked:false};
    check(state.codexOnboarding.visibleEntry&&state.codexOnboarding.entryFont>=14&&state.codexOnboarding.guideSequence,'Native onboarding entry/guide unavailable');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await wait('Usage guide focus return',()=>!document.querySelector('[role="dialog"]')&&document.activeElement===guide,5000);
    const updateStatus=await invoke({action:'update_status'});
    state.readability={smallButtons,minimumButtonFont:Math.min(...visibleButtons.map(button=>parseFloat(getComputedStyle(button).fontSize))),guideFont:guideSize,guideOpened:true,escapeRestoredFocus:true,horizontalOverflow:document.documentElement.scrollWidth>innerWidth};
    state.appUpdater={supported:updateStatus.supported,state:updateStatus.state,networkActions:updateNetworkActions};
    check(!smallButtons.length&&!state.readability.horizontalOverflow&&guideSize>=16,'Native readability checks failed');
    check(updateStatus.supported===false&&updateStatus.state==='unsupported'&&updateNetworkActions===0,'Native QA update gate failed');
    // Exercise the real native WebView controls using an explicitly mocked
    // planner response. Real subscription/Blender generation is verified by the
    // independent native game-bundle-proof example, never by this UI fixture.
    gameUiBaseline=await invoke({action:'snapshot'});gameUiPhase=true;
    const ui=state.gameBundleUi={nativeWebView:true,runtimeReadinessMocked:true,planResponseMocked:true,submissionIntercepted:true,providerRequests:0,initialRows:0,submittedItems:0,passed:false};
    const imageButton=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='이미지 제작');check(imageButton&&!imageButton.disabled,'Image bundle entry missing');imageButton.click();
    const panel=await wait('Native game bundle panel',()=>document.querySelector('.game-bundle-panel'),5000);
    check(document.querySelector('input[name="generation-mode"][value="separate"]')?.checked,'Individual assets must be the default image mode');
    const connectionCheck=await wait('Native fixture connection check',()=>[...panel.querySelectorAll('.provider-connection button')].find(button=>button.textContent.trim()==='연결 확인'&&!button.disabled),5000);connectionCheck.click();
    const setField=(element,value)=>{check(element,'Bundle field unavailable');Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));};
    setField(panel.querySelector('textarea[aria-label="이미지 설명"]'),'우주 전쟁 게임에 필요한 서로 다른 무기 5개');
    setField(panel.querySelector('input[aria-label="이미지 수"]'),'5');
    const planSubmit=panel.querySelector('button[type="submit"]');await wait('Native plan fixture enabled',()=>!planSubmit.disabled,5000);planSubmit.click();
    await wait('Five native reviewed item rows',()=>panel.querySelectorAll('.bundle-item').length===5,5000);ui.initialRows=5;
    check([...panel.querySelectorAll('.bundle-item input[aria-label$="번 에셋 이름"]')].map(field=>field.value).join('|')==='플라스마 소총|레이저 권총|중력 대포|EMP 발사기|광자 검','Reviewed items lost their distinct identities');
    check(panel.querySelector('.bundle-review-approval input')?.checked===false,'Review must require explicit approval');
    setField(panel.querySelector('input[aria-label="1번 에셋 이름"]'),'플라스마 소총 MK2');
    panel.querySelectorAll('.bundle-item-heading input[type="checkbox"]')[4].click();
    const approved=panel.querySelector('.bundle-review-approval input');await wait('Native review approval enabled',()=>!approved.disabled,5000);approved.click();
    const submit=[...panel.querySelectorAll('button')].find(button=>button.textContent.trim()==='검토한 에셋 묶음 제작');await wait('Native bundle fixture enabled',()=>!submit.disabled,5000);submit.click();
    await wait('Native bundle submission captured',()=>gameUiSubmission,5000);
    const included=gameUiSubmission.plan.items.filter(item=>item.enabled);ui.submittedItems=included.length;ui.names=included.map(item=>item.name);
    check(gameUiSubmission.approved===true&&included.length===4&&new Set(ui.names).size===4&&ui.names[0]==='플라스마 소총 MK2','Bundle review/exclusion/rename not reflected in submission');
    check(included.every(item=>item.prompt.includes(`이 파일에는 "${item.name}" 에셋 하나만`)),'Per-item single-asset rule missing');
    await wait('Native bundle dialog closed',()=>!document.querySelector('.dialog-generate'),5000);
    const afterUi=await invoke({action:'snapshot'});check(afterUi.project.assets.length===gameUiBaseline.project.assets.length&&afterUi.project.jobs.length===gameUiBaseline.project.jobs.length,'UI fixture unexpectedly created native work');
    ui.passed=true;gameUiPhase=false;
    // Pure UI fixture: no weight download, inference, Blender or queued work.
    qualityUiPhase=true;
    const qualityUi=state.quality3dUi={nativeWebView:true,runtimeStatusMocked:true,submissionIntercepted:true,realReconstruction:false,queuedJobs:0,inputs:0,passed:false};
    const qualityButton=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='3D 만들기');check(qualityButton&&!qualityButton.disabled,'Quality 3D entry unavailable');qualityButton.click();
    const qualityPanel=await wait('Native quality panel',()=>document.querySelector('.quality3d-panel'),5000);
    await wait('Quality ready status fixture',()=>qualityPanel.querySelector('.quality3d-state.ready'),5000);
    for(const chosen of [...qualityPanel.querySelectorAll('.quality3d-input[aria-pressed="true"]')]){chosen.click();await sleep(150);}
    for(let index=0;index<5;index++){
      const candidate=[...qualityPanel.querySelectorAll('.quality3d-input')].find(button=>button.getAttribute('aria-pressed')!=='true'&&!button.disabled);check(candidate,'Distinct quality input unavailable');candidate.click();
      await wait('Quality input selected',()=>qualityPanel.querySelectorAll('.quality3d-input[aria-pressed="true"]').length===index+1,5000);
    }
    check(qualityPanel.querySelector('.quality3d-output-summary').textContent.includes('개별 3D 에셋 5개'),'Individual 3D output count not visible');
    const qualitySubmit=qualityPanel.querySelector('button[type="submit"]');
    // Blender readiness is obtained from real environment; this isolated UI
    // check only uses the fixture when Blender is installed on the Mac.
    if(state.ipcEnvironment.blenderPath){
      await wait('Quality fixture submission enabled',()=>!qualitySubmit.disabled,5000);qualitySubmit.click();
      await wait('Quality submission captured',()=>qualityUiSubmission,5000);
      check(qualityUiSubmission.assetIds.length===5&&new Set(qualityUiSubmission.assetIds).size===5&&qualityUiSubmission.maxTriangles<=gameUiBaseline.project.spec.polygonBudget,'Quality submission lost individual inputs/budget');
      qualityUi.inputs=qualityUiSubmission.assetIds.length;qualityUi.settings=qualityUiSubmission;
      await wait('Quality dialog closed',()=>!document.querySelector('.dialog-quality3d'),5000);
    }else{
      qualityUi.blenderUnavailable=true;qualityUi.inputs=5;check(qualitySubmit.disabled,'Missing Blender must block quality submission');
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait('Quality dialog close',()=>!document.querySelector('.dialog-quality3d'),5000);
    }
    const afterQuality=await invoke({action:'snapshot'});check(afterQuality.project.assets.length===gameUiBaseline.project.assets.length&&afterQuality.project.jobs.length===gameUiBaseline.project.jobs.length,'Quality UI fixture created native work');
    qualityUi.passed=true;qualityUiPhase=false;
    if(withModel){
      const report=state.native3D={requested:true,passed:false,stage:'initial snapshot',assetId:null,generator:'Blender',blenderUsed:false,modelJobSucceeded:false,parameters:null,glbFetch:null,webgl:{context:false,drawCalls:0,defaultFramebufferDrawCalls:0,pixelReadbacks:0,pixelColorVariation:false,pixels:[],visibilityState:document.visibilityState},externalProviderCalls:0,error:null};
      const baseline=await invoke({action:'snapshot'}),oldAssetIds=new Set(baseline.project.assets.map(asset=>asset.id)),oldJobIds=new Set(baseline.project.jobs.map(job=>job.id));
      check(baseline.project.assets.filter(asset=>asset.versions.some(version=>version.source==='fixture')).length===12,'Expected twelve fixture originals');
      check(state.ipcEnvironment.native===true&&state.ipcEnvironment.blenderVersion,'Native Blender unavailable');
      const originalFetch=window.fetch;
      window.fetch=async function(...args){
        const response=await Reflect.apply(originalFetch,this,args),url=typeof args[0]==='string'?args[0]:args[0]?.url??String(args[0]);
        if(/\.glb(?:[?#]|$)/i.test(url)){
          const record=report.glbFetch={url,ok:response.ok,bytes:0,sha256:null,headerValid:false};
          response.clone().arrayBuffer().then(async data=>{record.bytes=data.byteLength;Object.assign(record,readGlb(data));record.sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(value=>value.toString(16).padStart(2,'0')).join('');}).catch(error=>{record.error=String(error);});
        }
        return response;
      };
      restores.push(()=>{window.fetch=originalFetch;});
      for(const Constructor of [window.WebGLRenderingContext,window.WebGL2RenderingContext]){
        if(!Constructor)continue;
        for(const method of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']){
          const descriptor=Object.getOwnPropertyDescriptor(Constructor.prototype,method);if(!descriptor?.value)continue;
          Constructor.prototype[method]=function(...args){
            const value=Reflect.apply(descriptor.value,this,args);
            if(this.canvas?.getAttribute('aria-label')==='회전, 이동, 확대 가능한 3D 모델 뷰포트'&&!this.isContextLost()&&this.getParameter(this.FRAMEBUFFER_BINDING)===null&&document.querySelector('.model-viewport-help')){
              const stats=report.webgl;stats.context=true;stats.drawCalls++;stats.defaultFramebufferDrawCalls++;
              if(stats.drawCalls<=24){
                const width=this.drawingBufferWidth,height=this.drawingBufferHeight;
                const pixels=[[.5,.5],[.25,.25],[.75,.75],[.25,.75],[.75,.25]].map(([x,y])=>{const rgba=new Uint8Array(4);this.readPixels(Math.floor(width*x),Math.floor(height*y),1,1,this.RGBA,this.UNSIGNED_BYTE,rgba);return [...rgba];});
                if(this.getError()===this.NO_ERROR){stats.pixelReadbacks++;stats.pixels=pixels;stats.width=width;stats.height=height;if(pixels.every(pixel=>pixel[3]>0)&&pixels.some(pixel=>pixel.slice(0,3).some((channel,axis)=>Math.abs(channel-pixels[0][axis])>8)))stats.pixelColorVariation=true;}
              }
            }
            return value;
          };
          restores.push(()=>Object.defineProperty(Constructor.prototype,method,descriptor));
        }
      }
      report.stage='open model dialog';
      const button=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='3D 만들기');check(button&&!button.disabled,'3D create button unavailable');button.click();
      await wait('3D route dialog',()=>document.querySelector('.dialog-quality3d')||document.querySelector('.dialog-model'),5000);
      if(document.querySelector('.dialog-quality3d')){
        const recipe=[...document.querySelectorAll('.dialog-quality3d button')].find(button=>button.textContent.trim()==='기본 소품 레시피');check(recipe,'Procedural recipe route unavailable');recipe.click();
      }
      const form=await wait('Model dialog',()=>document.querySelector('.dialog-model form'),5000);
      const inputFor=text=>[...form.querySelectorAll('label')].find(label=>label.querySelector('span')?.textContent===text)?.querySelector('input');
      const setInput=(input,value)=>{check(input,'Model field unavailable');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
      setInput(inputFor('제작 수'),'1');setInput(inputFor('모델 이름'),'Native QA Crate');await sleep(100);check(form.checkValidity(),'Native model default form invalid');
      report.parameters={template:'crate',name:'Native QA Crate',width:Number(inputFor('너비 (m)').value),depth:Number(inputFor('깊이 (m)').value),height:Number(inputFor('높이 (m)').value),bevel:Number(inputFor('모서리 베벨 (m)').value),count:1,unit:'m'};
      check(['width','depth','height'].every(key=>report.parameters[key]===1),'Expected one-meter default dimensions');
      const submit=form.querySelector('button[type="submit"]');check(submit&&!submit.disabled,'Model submit unavailable');submit.click();
      report.stage='native Blender job';
      const produced=await wait('Native Blender model',async()=>{
        const snapshot=await invoke({action:'snapshot'}),jobs=snapshot.project.jobs.filter(job=>!oldJobIds.has(job.id));
        check(!jobs.some(job=>job.resource==='external'),'Unexpected external job');
        const failed=jobs.find(job=>['failed','cancelled','external_unknown'].includes(job.status));if(failed)throw new Error(`${failed.kind}: ${failed.error??failed.status}`);
        const asset=snapshot.project.assets.find(asset=>!oldAssetIds.has(asset.id)&&asset.kind==='model'),job=jobs.find(job=>job.kind==='blender_model'&&job.resource==='blender'&&job.status==='succeeded');
        return asset&&job?{asset,job}:null;
      },180000);
      report.assetId=produced.asset.id;report.jobId=produced.job.id;report.modelJobSucceeded=true;report.blenderVersion=state.ipcEnvironment.blenderVersion;
      const version=produced.asset.versions.find(version=>version.id===produced.asset.activeVersionId),glb=version?.artifacts.find(artifact=>artifact.format.toLowerCase()==='glb');
      report.blenderUsed=!!version?.artifacts.some(artifact=>artifact.format.toLowerCase()==='blend'&&artifact.bytes>0);
      check(glb&&report.blenderUsed&&version.validation?.valid,'Native GLB, Blender source or validation missing');
      report.stage='open actual model card';
      const card=await wait('Generated model card',()=>[...document.querySelectorAll('[aria-label="에셋 목록"] [role="listitem"]')].find(card=>card.querySelector('strong')?.textContent===produced.asset.name),10000);
      card.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));report.stage='GLB load and native WebGL rendering';
      await wait('Loaded GLB and WebGL pixels',()=>{
        const failure=document.querySelector('.model-viewport-error');if(failure)throw new Error(failure.textContent.trim());
        check(!report.glbFetch?.error,report.glbFetch?.error??'GLB fetch failed');
        return document.querySelector('.model-viewport-help')&&report.glbFetch?.headerValid&&report.glbFetch?.sha256&&report.webgl.drawCalls>0&&report.webgl.pixelReadbacks>0&&report.webgl.pixelColorVariation;
      },25000);
      check(report.glbFetch.ok&&/asset\.localhost|^asset:/.test(report.glbFetch.url),'GLB did not use native asset protocol');
      check(report.glbFetch.bytes===glb.bytes&&report.glbFetch.sha256===glb.sha256,'Viewport GLB differs from stored artifact');
      check(report.glbFetch.bounds.dimensions.every(value=>Math.abs(value-1)<.0001),'Decoded GLB dimensions differ from one meter');
      check(providerCalls===0,'External provider command attempted');report.externalProviderCalls=providerCalls;report.stage='complete';report.passed=true;
    }
  }catch(error){
    state.error=error instanceof Error?error.message:String(error);state.imageCount=document.querySelectorAll('img').length;
    if(state.gameBundleUi&&!state.gameBundleUi.passed)state.gameBundleUi.controls=[...document.querySelectorAll('.game-bundle-panel button')].map(button=>({label:button.textContent.trim().slice(0,80),disabled:button.disabled}));
    state.images=[...document.querySelectorAll('img')].slice(0,3).map(image=>({src:image.src,complete:image.complete,width:image.naturalWidth}));state.alert=document.querySelector('[role="alert"]')?.textContent?.slice(0,500);
    if(state.native3D){state.native3D.error=state.error;state.native3D.externalProviderCalls=providerCalls;}
  }finally{state.externalProviderCalls=providerCalls;state.updateNetworkActions=updateNetworkActions;if(state.appUpdater)state.appUpdater.networkActions=updateNetworkActions;if(updateNetworkActions>0)state.error='Native QA attempted an update network action';for(const restore of restores.reverse())restore();}
  await window.__TAURI__.core.invoke('native_qa_complete',{report:state});
})().catch(console.error);
