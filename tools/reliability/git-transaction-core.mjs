import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { defaultFailureClassification } from './failure-classification.mjs';
import { parseProvenanceTrailers, PRODUCER_VALUES } from './provenance.mjs';

const PRODUCER_SET = new Set(PRODUCER_VALUES);
const TX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const SHA40 = /^[0-9a-f]{40}$/;

export function git(repoDir,args,{allowFailure=false}={}){const r=spawnSync('git',['-C',repoDir,...args],{encoding:'utf8'});if(!allowFailure&&r.status!==0){const d=`${r.stdout??''}${r.stderr??''}`.trim();throw new Error(`git ${args.join(' ')} failed${d?`: ${d}`:'.'}`);}return r;}
export function gitOutput(repoDir,args){return git(repoDir,args).stdout.trim();}
export function gitSucceeds(repoDir,args){return git(repoDir,args,{allowFailure:true}).status===0;}
export function repoRoot(repoDir){return gitOutput(repoDir,['rev-parse','--show-toplevel']);}
export function branchRef(branch){if(typeof branch!=='string'||branch.trim()==='')throw new Error('branch is required.');return branch.startsWith('refs/heads/')?branch:`refs/heads/${branch}`;}
export function currentSymbolicHead(repoDir){const r=git(repoDir,['symbolic-ref','-q','HEAD'],{allowFailure:true});return r.status===0?r.stdout.trim():null;}
export function refValue(repoDir,ref){const r=git(repoDir,['rev-parse','--verify',ref],{allowFailure:true});return r.status===0?r.stdout.trim():null;}
export function projectionMatches(repoDir,commit){return SHA40.test(commit)&&gitSucceeds(repoDir,['diff','--quiet',commit,'--'])&&gitSucceeds(repoDir,['diff','--cached','--quiet',commit,'--'])&&gitOutput(repoDir,['ls-files','--others','--exclude-standard'])==='';}
export function isAncestor(repoDir,a,b){return gitSucceeds(repoDir,['merge-base','--is-ancestor',a,b]);}

export function validateTransactionId(repoDir,transactionId){if(typeof transactionId!=='string'||!TX_ID.test(transactionId))throw new Error('transactionId has an invalid shape.');const ref=`refs/transactions/${transactionId}`;if(!gitSucceeds(repoDir,['check-ref-format',ref]))throw new Error(`transactionId cannot form a valid Git ref: ${transactionId}`);return transactionId;}
function transactionRoot(repoDir){const key=crypto.createHash('sha256').update(repoRoot(repoDir)).digest('hex').slice(0,16);return path.join(os.tmpdir(),'development-reliability-transactions',key);}
export function getTransactionWorktreePath(repoDir,transactionId){return path.join(transactionRoot(repoDir),transactionId);}
function canonicalPath(value){let resolved=path.resolve(value);try{resolved=fs.realpathSync.native(resolved);}catch{}return process.platform==='win32'?resolved.toLowerCase():resolved;}
function isPathInside(root,candidate){const relative=path.relative(canonicalPath(root),canonicalPath(candidate));return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);}
export function listReliabilityWorktrees(repoDir){const root=transactionRoot(repoDir);const raw=gitOutput(repoDir,['worktree','list','--porcelain']);const result=[];for(const block of raw.split(/\r?\n\r?\n/)){const line=block.split(/\r?\n/).find(x=>x.startsWith('worktree '));if(!line)continue;const worktree=line.slice('worktree '.length);if(isPathInside(root,worktree))result.push(worktree);}return result;}
export function removeCleanTransactionWorktree(repoDir,worktreeDir){if(!worktreeDir||!fs.existsSync(worktreeDir))return true;if(!projectionMatches(worktreeDir,gitOutput(worktreeDir,['rev-parse','HEAD'])))return false;return git(repoDir,['worktree','remove',worktreeDir],{allowFailure:true}).status===0;}

export function assertPrimaryProjection(repoDir,expectedRef,expectedCommit,{transactionId=null,candidateCommit=null}={}){const symbolic=currentSymbolicHead(repoDir);if(symbolic!==expectedRef)throw transactionError('Primary worktree is not attached to the expected branch.',{failureClass:'unsafe_dirty_state',reasonCode:'primary-branch-mismatch',transactionId,baseCommit:expectedCommit,candidateCommit,details:{expectedRef,actualRef:symbolic}});if(!projectionMatches(repoDir,expectedCommit))throw transactionError('Primary worktree contains changes that are not safe to overwrite.',{failureClass:'unsafe_dirty_state',reasonCode:'primary-projection-not-clean-at-base',transactionId,baseCommit:expectedCommit,candidateCommit});}

export function buildCommitMessage({commitMessage,transactionId,producer,interactionId=null,workstreamId=null}){if(typeof commitMessage!=='string'||commitMessage.trim()==='')throw new Error('commitMessage is required.');if(!PRODUCER_SET.has(producer))throw new Error(`Unsupported producer: ${producer}`);const base=commitMessage.trimEnd(),t=parseProvenanceTrailers(base);if(t.developmentTransactions.length&&!t.developmentTransactions.includes(transactionId))throw new Error('commitMessage contains a conflicting Development-Transaction trailer.');if(t.producers.length&&!t.producers.includes(producer))throw new Error('commitMessage contains a conflicting Producer trailer.');const a=[];if(!t.developmentTransactions.includes(transactionId))a.push(`Development-Transaction: ${transactionId}`);if(interactionId&&!t.interactionIds.includes(interactionId))a.push(`Interaction-Id: ${interactionId}`);if(workstreamId&&!t.workstreamIds.includes(workstreamId))a.push(`Workstream-Id: ${workstreamId}`);if(!t.producers.includes(producer))a.push(`Producer: ${producer}`);return a.length?`${base}\n\n${a.join('\n')}`:base;}
export function createCandidateCommit(worktreeDir,message){git(worktreeDir,['diff','--check']);git(worktreeDir,['add','-A']);git(worktreeDir,['diff','--cached','--check']);if(gitSucceeds(worktreeDir,['diff','--cached','--quiet']))return null;const name=git(worktreeDir,['config','--get','user.name'],{allowFailure:true}).stdout.trim()||'Development Reliability';const email=git(worktreeDir,['config','--get','user.email'],{allowFailure:true}).stdout.trim()||'reliability@local.invalid';git(worktreeDir,['-c',`user.name=${name}`,'-c',`user.email=${email}`,'commit','--no-gpg-sign','-m',message]);return gitOutput(worktreeDir,['rev-parse','HEAD']);}
export function transactionError(message,{failureClass,reasonCode,committed=false,transactionId=null,baseCommit=null,candidateCommit=null,details=null,cause=null}={}){const c=defaultFailureClassification(failureClass,reasonCode);const e=new Error(message,cause?{cause}:undefined);e.name='LocalGitTransactionError';e.code=reasonCode;e.failureClass=c.failureClass;e.disposition=c.disposition;e.retryable=c.retryable;e.writeBlocked=c.writeBlocked;e.committed=committed;e.transactionId=transactionId;e.baseCommit=baseCommit;e.candidateCommit=candidateCommit;e.details=details;return e;}
