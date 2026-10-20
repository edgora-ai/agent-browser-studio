import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { browserLaunchProcessFromArgv, type BrowserLaunchProcess } from "../../../src/main/services/process-discovery.js";

export interface ExpectedNativeLaunchIdentity {
  pid: number;
  /** Trusted, already-canonical owned launch paths, not facts learned from argv. */
  executablePath: string;
  argv0: string;
  profileDir: string;
  port: number;
}
export interface NativeArgvGenerationWitness {
  pid: number;
  uid: number;
  ppid: number;
  startSeconds: string;
  startMicroseconds: string;
}
export const NATIVE_ARGV_LIMITATIONS = [
  "Public installed macOS SDK proc_bsdinfo exposes PID start time, not an exec-generation counter. Matching start time and executable paths does not prove absence of same-image exec/ABA.",
  "The caller must establish that the expected PID and launch identity belong to its owned launch; this observer brackets acquisition, not the process lifetime before the call.",
  "Leading-empty argv ambiguity and bare environment-shaped argument candidates are rejected, not recovered by reading or returning the trailing environment.",
] as const;
export interface OwnedNativeArgvObservation extends BrowserLaunchProcess {
  ownershipWitness: {
    source: "PROC_PIDTBSDINFO+proc_pidpath+KERN_PROCARGS2";
    before: NativeArgvGenerationWitness;
    after: NativeArgvGenerationWitness;
    execGeneration: "unavailable-public-sdk";
    fullExecGenerationProof: false;
    limitations: readonly string[];
  };
}

// The public installed SDK declares PROC_PIDTBSDINFO=3, proc_bsdinfo (136 bytes,
// MAXCOMLEN=16), and proc_pidpath. It does not declare the private unique-ID /
// exec-generation flavors. Do not guess private flavor numbers or struct ABIs.
// Raw KERN_PROCARGS2 bytes, including its environment tail, stay inside Python.
export const DARWIN_ARGV_READER = String.raw`
import base64,ctypes,json,os,re,struct,sys

MAX_BYTES=262144
LIMITATIONS=[
 'Public installed macOS SDK proc_bsdinfo exposes PID start time, not an exec-generation counter. Matching start time and executable paths does not prove absence of same-image exec/ABA.',
 'The caller must establish that the expected PID and launch identity belong to its owned launch; this observer brackets acquisition, not the process lifetime before the call.',
 'Leading-empty argv ambiguity and bare environment-shaped argument candidates are rejected, not recovered by reading or returning the trailing environment.'
]
class Rejected(Exception):
    def __init__(self,code,native_errno=None):
        self.code=code
        self.native_errno=native_errno

def require(condition,code):
    if not condition: raise Rejected(code)

def canonical_path(value):
    return isinstance(value,str) and 0<len(os.fsencode(value))<4096 and '\0' not in value and os.path.isabs(value) and os.path.normpath(value)==value

def expectation(value):
    require(isinstance(value,dict) and set(value)=={'pid','executablePath','argv0','profileDir','port'},'invalid-expectation')
    require(type(value['pid']) is int and 1<=value['pid']<=2147483647,'invalid-owned-pid')
    require(all(canonical_path(value[key]) for key in ['executablePath','argv0','profileDir']),'invalid-expected-path')
    require(value['argv0']==value['executablePath'],'expected-argv0-not-canonical-executable')
    require(type(value['port']) is int and 1<=value['port']<=65535,'invalid-expected-port')
    return value

def snapshot(value,expected):
    require(isinstance(value,dict) and set(value)=={'executablePath','generation'},'invalid-process-witness')
    require(value['executablePath']==expected['executablePath'],'observed-executable-mismatch')
    generation=value['generation']
    require(isinstance(generation,dict) and set(generation)=={'pid','uid','ppid','startSeconds','startMicroseconds'},'invalid-generation-witness')
    require(generation['pid']==expected['pid'] and type(generation['pid']) is int,'observed-pid-mismatch')
    require(type(generation['uid']) is int and generation['uid']==os.getuid(),'observed-uid-mismatch')
    require(type(generation['ppid']) is int and 1<=generation['ppid']<=2147483647,'invalid-parent-witness')
    require(isinstance(generation['startSeconds'],str) and re.fullmatch(r'[1-9][0-9]{0,19}',generation['startSeconds']) is not None,'invalid-start-time')
    require(isinstance(generation['startMicroseconds'],str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,5})',generation['startMicroseconds']) is not None and int(generation['startMicroseconds'])<1000000,'invalid-start-time')
    return generation

def decode_argv(data,expected):
    require(isinstance(data,bytes) and 5<=len(data)<=MAX_BYTES,'argument-byte-budget')
    argc=struct.unpack_from('=i',data,0)[0]
    require(1<=argc<=256,'argument-count-budget')
    end=data.find(b'\0',4)
    require(end>4,'missing-kernel-executable')
    require(data[4:end]==os.fsencode(expected['executablePath']),'kernel-executable-mismatch')
    position=end+1
    while position<len(data) and data[position]==0: position+=1
    end=data.find(b'\0',position)
    require(end>=position and data[position:end]==os.fsencode(expected['argv0']),'argv0-mismatch-or-leading-empty')
    args=[]
    for _ in range(argc):
        end=data.find(b'\0',position)
        require(end>=position,'incomplete-argument-inventory')
        raw=data[position:end]
        # KERN_PROCARGS2 cannot distinguish initial empty argv entries from its
        # NUL padding. Never release an environment-shaped candidate shifted
        # into argc slots, even if a later argv entry repeats the expected argv0.
        require(re.match(rb'[^=\x00\s]+=',raw) is None or raw.startswith(b'-') or re.match(rb'[A-Za-z][A-Za-z0-9+.-]*:',raw) is not None,'ambiguous-environment-argument')
        args.append(os.fsdecode(raw))
        position=end+1
    profile='--user-data-dir='+expected['profileDir']
    port='--remote-debugging-port='+str(expected['port'])
    require([arg for arg in args[1:] if arg=='--user-data-dir' or arg.startswith('--user-data-dir=')]==[profile],'owned-profile-flag-mismatch')
    require([arg for arg in args[1:] if arg=='--remote-debugging-port' or arg.startswith('--remote-debugging-port=')]==[port],'owned-port-flag-mismatch')
    return args

def validate_capture(expected,before,data,after):
    expected=expectation(expected)
    first=snapshot(before,expected)
    last=snapshot(after,expected)
    require(first==last,'process-generation-changed')
    args=decode_argv(data,expected)
    return {'pid':expected['pid'],'executablePath':expected['executablePath'],'args':args,
      'ownershipWitness':{'source':'PROC_PIDTBSDINFO+proc_pidpath+KERN_PROCARGS2','before':first,'after':last,
        'execGeneration':'unavailable-public-sdk','fullExecGenerationProof':False,'limitations':LIMITATIONS}}

class BsdInfo(ctypes.Structure):
    _fields_=[('pbi_flags',ctypes.c_uint32),('pbi_status',ctypes.c_uint32),('pbi_xstatus',ctypes.c_uint32),
      ('pbi_pid',ctypes.c_uint32),('pbi_ppid',ctypes.c_uint32),('pbi_uid',ctypes.c_uint32),
      ('pbi_gid',ctypes.c_uint32),('pbi_ruid',ctypes.c_uint32),('pbi_rgid',ctypes.c_uint32),
      ('pbi_svuid',ctypes.c_uint32),('pbi_svgid',ctypes.c_uint32),('rfu_1',ctypes.c_uint32),
      ('pbi_comm',ctypes.c_char*16),('pbi_name',ctypes.c_char*32),
      ('pbi_nfiles',ctypes.c_uint32),('pbi_pgid',ctypes.c_uint32),('pbi_pjobc',ctypes.c_uint32),
      ('e_tdev',ctypes.c_uint32),('e_tpgid',ctypes.c_uint32),('pbi_nice',ctypes.c_int32),
      ('pbi_start_tvsec',ctypes.c_uint64),('pbi_start_tvusec',ctypes.c_uint64)]

def acquire(expected):
    require(sys.platform=='darwin','macos-observer-required')
    expected=expectation(expected)
    require(ctypes.sizeof(BsdInfo)==136,'unsupported-bsdinfo-layout')
    libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
    libc.sysctl.argtypes=[ctypes.POINTER(ctypes.c_int),ctypes.c_uint,ctypes.c_void_p,ctypes.POINTER(ctypes.c_size_t),ctypes.c_void_p,ctypes.c_size_t]
    libc.sysctl.restype=ctypes.c_int
    proc=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
    proc.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
    proc.proc_pidpath.restype=ctypes.c_int
    proc.proc_pidinfo.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_uint64,ctypes.c_void_p,ctypes.c_int]
    proc.proc_pidinfo.restype=ctypes.c_int
    pid=expected['pid']
    def process_info():
        info=BsdInfo()
        count=proc.proc_pidinfo(pid,3,0,ctypes.byref(info),ctypes.sizeof(info))
        if count!=ctypes.sizeof(info): raise Rejected('bsdinfo-unavailable',ctypes.get_errno())
        require(info.pbi_pid==pid and info.pbi_uid==os.getuid() and info.pbi_ruid==os.getuid(),'unowned-process-identity')
        require(not info.pbi_flags & 4,'process-is-exiting')
        return {'pid':int(info.pbi_pid),'uid':int(info.pbi_uid),'ppid':int(info.pbi_ppid),
          'startSeconds':str(info.pbi_start_tvsec),'startMicroseconds':str(info.pbi_start_tvusec)}
    def executable_path():
        buffer=ctypes.create_string_buffer(4096)
        count=proc.proc_pidpath(pid,buffer,4096)
        if count<=0 or count>=4096: raise Rejected('executable-path-unavailable',ctypes.get_errno())
        require(buffer.value==os.fsencode(expected['executablePath']),'observed-executable-mismatch')
        return os.fsdecode(buffer.value)
    first=process_info()
    before={'generation':first,'executablePath':executable_path()}
    mib=(ctypes.c_int*3)(1,49,pid) # CTL_KERN, KERN_PROCARGS2, exact owned PID.
    size=ctypes.c_size_t()
    if libc.sysctl(mib,3,None,ctypes.byref(size),None,0): raise Rejected('argv-size-read-failed',ctypes.get_errno())
    require(5<=size.value<=MAX_BYTES,'argument-byte-budget')
    buffer=ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib,3,buffer,ctypes.byref(size),None,0): raise Rejected('argv-read-failed',ctypes.get_errno())
    require(5<=size.value<=len(buffer),'argument-byte-budget')
    after_path=executable_path()
    after={'executablePath':after_path,'generation':process_info()}
    return validate_capture(expected,before,buffer.raw[:size.value],after)

try:
    raw=sys.stdin.buffer.read(600001)
    require(len(raw)<=600000,'observer-input-budget')
    value=json.loads(raw)
    if len(sys.argv)==2 and sys.argv[1]=='decode-fixture':
        require(isinstance(value,dict) and set(value)=={'expected','before','buffer','after'},'invalid-fixture-envelope')
        require(isinstance(value['buffer'],str) and len(value['buffer'])<=349528,'argument-byte-budget')
        data=base64.b64decode(value['buffer'],validate=True)
        result=validate_capture(value['expected'],value['before'],data,value['after'])
    else:
        require(len(sys.argv)==2 and sys.argv[1]=='observe','invalid-observer-mode')
        result=acquire(value)
    encoded=json.dumps(result,ensure_ascii=True).encode('utf-8')
    require(len(encoded)<524288,'observer-output-budget')
    sys.stdout.buffer.write(encoded+b'\n')
except Exception as error:
    # No raw buffer, argv, paths, expectation or exception text on failure.
    failure={'error':error.code if isinstance(error,Rejected) else 'observer-input-or-runtime-error'}
    if isinstance(error,Rejected) and error.native_errno is not None: failure['errno']=error.native_errno
    sys.stderr.write(json.dumps(failure)+'\n')
    sys.exit(1)
`;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonicalPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) < 4096 &&
    !value.includes("\0") && path.isAbsolute(value) && path.resolve(value) === value;
}
function validWitness(value: unknown, pid: number): value is NativeArgvGenerationWitness {
  return record(value) && value.pid === pid && Number.isSafeInteger(value.uid) && Number(value.uid) >= 0 &&
    Number.isSafeInteger(value.ppid) && Number(value.ppid) > 0 && typeof value.startSeconds === "string" && /^[1-9]\d{0,19}$/.test(value.startSeconds) &&
    typeof value.startMicroseconds === "string" && /^(?:0|[1-9]\d{0,5})$/.test(value.startMicroseconds) && Number(value.startMicroseconds) < 1000000;
}

/** Caller-owned Chromium launch only; no PID scan, private token or userData read.
 * This brackets acquisition with the SDK's PID-start witness. It is explicitly
 * NOT complete exec-generation proof; retain the live CDP-to-PID checks too. */
export function readOwnedNativeArgv(expected: ExpectedNativeLaunchIdentity): OwnedNativeArgvObservation {
  if (process.platform !== "darwin" || !record(expected) || !Number.isSafeInteger(expected.pid) || expected.pid < 1 || expected.pid > 2147483647 ||
      !canonicalPath(expected.executablePath) || !canonicalPath(expected.argv0) || expected.argv0 !== expected.executablePath ||
      !canonicalPath(expected.profileDir) || !Number.isSafeInteger(expected.port) || expected.port < 1 || expected.port > 65535) {
    throw new Error("Native argv observation requires the exact owned macOS launch identity");
  }
  const executablePath = expected.executablePath;
  const identity: ExpectedNativeLaunchIdentity = { pid: expected.pid, executablePath, argv0: expected.argv0,
    profileDir: expected.profileDir, port: expected.port };
  const output = execFileSync("python3", ["-I", "-S", "-B", "-c", DARWIN_ARGV_READER, "observe"], {
    input: JSON.stringify(identity), encoding: "utf8", timeout: 5_000, maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH, LC_ALL: "C" }, stdio: "pipe",
  });
  const value: unknown = JSON.parse(output);
  if (!record(value) || value.pid !== identity.pid || value.executablePath !== executablePath ||
      !Array.isArray(value.args) || value.args.length < 1 || value.args.length > 256 || value.args[0] !== identity.argv0 ||
      value.args.some((arg: unknown) => typeof arg !== "string" || arg.includes("\0")) || !record(value.ownershipWitness)) {
    throw new Error("Invalid owned process argv observation");
  }
  const witness = value.ownershipWitness;
  if (witness.source !== "PROC_PIDTBSDINFO+proc_pidpath+KERN_PROCARGS2" || !validWitness(witness.before, identity.pid) ||
      !validWitness(witness.after, identity.pid) || JSON.stringify(witness.before) !== JSON.stringify(witness.after) ||
      witness.execGeneration !== "unavailable-public-sdk" || witness.fullExecGenerationProof !== false ||
      JSON.stringify(witness.limitations) !== JSON.stringify(NATIVE_ARGV_LIMITATIONS)) throw new Error("Invalid native argv generation witness");
  const observed = browserLaunchProcessFromArgv(identity.pid, executablePath, value.args.slice(1));
  if (observed.malformed || JSON.stringify(observed.profileDirs) !== JSON.stringify([identity.profileDir]) ||
      JSON.stringify(observed.cdpPorts) !== JSON.stringify([identity.port])) throw new Error("Owned argv launch fields disagree");
  return { ...observed, ownershipWitness: { source: "PROC_PIDTBSDINFO+proc_pidpath+KERN_PROCARGS2", before: witness.before, after: witness.after,
    execGeneration: "unavailable-public-sdk", fullExecGenerationProof: false, limitations: NATIVE_ARGV_LIMITATIONS } };
}
