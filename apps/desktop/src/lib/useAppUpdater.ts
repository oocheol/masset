import {useCallback,useEffect,useRef,useState} from 'react';
import type {AppUpdateStatus} from '@local-assets/contracts';
import {command,isNative} from './bridge';
import {APP_VERSION,hasUpdateReview,unsupportedUpdateStatus} from './appUpdate';

const CHECK_INTERVAL=10*60*1000;
const STATUS_INTERVAL=750;
const TRANSFER_STATES=new Set<AppUpdateStatus['state']>(['downloading','installing']);
type UpdateAction='check'|'install'|null;

export function useAppUpdater(workBlocked:boolean) {
  const [status,setStatus]=useState<AppUpdateStatus>(()=>isNative?{
    supported:true,currentVersion:APP_VERSION,latestVersion:null,state:'idle',downloadedBytes:0,
    totalBytes:null,sha256:null,releaseUrl:null,message:'업데이트 확인 전입니다.',checkedAt:null,
  }:unsupportedUpdateStatus());
  const [action,setAction]=useState<UpdateAction>(null);
  const statusRef=useRef(status);
  const actionRef=useRef<UpdateAction>(null);
  const blockedRef=useRef(workBlocked);
  const mounted=useRef(true);
  const initialChecked=useRef(false);
  const polling=useRef(false);
  blockedRef.current=workBlocked;

  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const accept=useCallback((next:AppUpdateStatus)=>{
    statusRef.current=next;
    if(mounted.current)setStatus(next);
  },[]);
  const fail=useCallback((error:unknown)=>accept({...statusRef.current,state:'error',message:error instanceof Error?error.message:String(error)}),[accept]);

  const check=useCallback(async():Promise<boolean>=>{
    if(!isNative||blockedRef.current||actionRef.current||TRANSFER_STATES.has(statusRef.current.state)||statusRef.current.state==='checking')return false;
    actionRef.current='check';
    if(mounted.current)setAction('check');
    try {
      // Native QA and unsupported platforms are gated before any release-network check.
      const current=await command<AppUpdateStatus>({action:'update_status'});
      accept(current);
      if(!current.supported){initialChecked.current=true;return true;}
      if(blockedRef.current||TRANSFER_STATES.has(current.state)||current.state==='checking')return false;
      accept({...current,state:'checking',message:'GitHub 릴리스에서 새 버전을 확인 중입니다.'});
      initialChecked.current=true;
      accept(await command<AppUpdateStatus>({action:'update_check'}));
      return true;
    } catch(error) {
      initialChecked.current=true;
      fail(error);
      return true;
    } finally {
      actionRef.current=null;
      if(mounted.current)setAction(null);
    }
  },[accept,fail]);

  const install=useCallback(async():Promise<void>=>{
    const current=statusRef.current;
    if(!isNative||blockedRef.current||actionRef.current||!current.supported||current.state!=='available'||!hasUpdateReview(current))return;
    actionRef.current='install';
    if(mounted.current)setAction('install');
    accept({...current,state:'downloading',downloadedBytes:0,message:'확인한 업데이트의 다운로드를 시작합니다.'});
    try {accept(await command<AppUpdateStatus>({action:'update_install',expectedVersion:current.latestVersion,expectedSha256:current.sha256}));}
    catch(error){fail(error);}
    finally {
      actionRef.current=null;
      if(mounted.current)setAction(null);
    }
  },[accept,fail]);

  useEffect(()=>{
    if(!isNative)return;
    let stopped=false;
    let timeout:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      if(stopped)return;
      await check();
      if(!stopped)timeout=setTimeout(tick,initialChecked.current?CHECK_INTERVAL:1000);
    };
    timeout=setTimeout(tick,0);
    return()=>{stopped=true;clearTimeout(timeout);};
  },[check]);

  const transferring=action==='install'||TRANSFER_STATES.has(status.state);
  const shouldPoll=transferring||status.state==='checking';
  useEffect(()=>{
    if(!isNative||!shouldPoll)return;
    let stopped=false;
    let timeout:ReturnType<typeof setTimeout>;
    const tick=async()=>{
      if(stopped)return;
      if(!polling.current){
        polling.current=true;
        try {
          const next=await command<AppUpdateStatus>({action:'update_status'});
          if(!stopped)accept(next);
        } catch(error) {
          // IPC can close as the installer restarts the app.
          if(!stopped&&statusRef.current.state!=='installing')fail(error);
        } finally {polling.current=false;}
      }
      if(!stopped)timeout=setTimeout(tick,STATUS_INTERVAL);
    };
    timeout=setTimeout(tick,STATUS_INTERVAL);
    return()=>{stopped=true;clearTimeout(timeout);};
  },[shouldPoll,accept,fail]);

  return {status,checking:action==='check'||status.state==='checking',transferring,check,install};
}
