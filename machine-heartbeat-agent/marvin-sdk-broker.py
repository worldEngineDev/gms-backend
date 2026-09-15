#!/usr/bin/env python3
"""常驻 Marvin SDK 控制 Broker。

该进程运行在 importer 容器（glibc 环境）中，连接会话跨 HTTP 请求保留，
只有 disconnect/exit 或进程退出时才调用 OnRelease。
"""
import argparse
import ctypes
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ARM_NAMES = ("A", "B")
STATE_NAMES = {0: "IDLE", 1: "POSITION", 2: "PVT", 3: "TORQUE", 4: "RELEASE"}


class MarvinController:
    def __init__(self, lib_path, robot_ip):
        self.lib = ctypes.CDLL(lib_path)
        self.robot_ip = robot_ip
        self.lock = threading.RLock()
        self.connected = False
        self._configure()

    def _configure(self):
        u8 = ctypes.c_ubyte
        self.lib.OnLinkTo.argtypes = [u8, u8, u8, u8]
        self.lib.OnLinkTo.restype = ctypes.c_bool
        self.lib.OnRelease.argtypes = []
        self.lib.OnRelease.restype = ctypes.c_bool
        for name in ("OnSetTargetState_A", "OnSetTargetState_B",
                     "OnSetImpType_A", "OnSetImpType_B",
                     "OnSetDragSpace_A", "OnSetDragSpace_B",
                     "OnSetJointLmt_A", "OnSetJointLmt_B"):
            fn = getattr(self.lib, name)
            fn.argtypes = [ctypes.c_int, ctypes.c_int] if "JointLmt" in name else [ctypes.c_int]
            fn.restype = ctypes.c_bool
        for name in ("OnSetJointKD_A", "OnSetJointKD_B",
                     "OnSetCartKD_A", "OnSetCartKD_B"):
            fn = getattr(self.lib, name)
            fn.argtypes = [ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double)] + ([ctypes.c_int] if "CartKD" in name else [])
            fn.restype = ctypes.c_bool
        for name in ("OnSetEefRot_A", "OnSetEefRot_B"):
            fn = getattr(self.lib, name)
            fn.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_double)]
            fn.restype = ctypes.c_bool
        for name in ("OnSetTool_A", "OnSetTool_B"):
            fn = getattr(self.lib, name)
            fn.argtypes = [ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double)]
            fn.restype = ctypes.c_bool
        for name in ("OnClearErr_A", "OnClearErr_B", "OnEMG_A", "OnEMG_B"):
            fn = getattr(self.lib, name)
            fn.argtypes = []
            # These SDK entry points are void functions.  Explicitly declare
            # the return type so ctypes does not interpret an undefined
            # register value as a false failure.
            fn.restype = None
        self.lib.OnEMG_AB.argtypes = []
        self.lib.OnEMG_AB.restype = None
        self.lib.OnGetServoErr_A.argtypes = [ctypes.POINTER(ctypes.c_long * 7)]
        self.lib.OnGetServoErr_B.argtypes = [ctypes.POINTER(ctypes.c_long * 7)]
        self.lib.OnClearSet.argtypes = []
        self.lib.OnClearSet.restype = None
        self.lib.OnSetSend.argtypes = []
        self.lib.OnSetSend.restype = ctypes.c_bool

    def _arms(self, arm):
        return list(ARM_NAMES) if arm == "AB" else [arm]

    def _call(self, name, arm, *args):
        fn = getattr(self.lib, f"{name}_{arm}")
        return bool(fn(*args))

    def connect(self):
        with self.lock:
            if self.connected:
                return {"success": True, "connected": True, "sdkCalled": False, "message": "机械臂已保持连接"}
            parts = [int(x) for x in self.robot_ip.split(".")]
            ok = bool(self.lib.OnLinkTo(*[ctypes.c_ubyte(x) for x in parts]))
            self.connected = ok
            if not ok:
                return {"success": False, "connected": False, "sdkCalled": True, "error": "机械臂连接失败，控制端口可能被占用"}
            return {"success": True, "connected": True, "sdkCalled": True, "message": "机械臂 SDK 已连接"}

    def release(self):
        with self.lock:
            if not self.connected:
                return {"success": True, "connected": False, "sdkCalled": False, "message": "机械臂连接已释放"}
            ok = bool(self.lib.OnRelease())
            self.connected = False
            return {"success": ok, "connected": False, "sdkCalled": True, "message": "机械臂连接已释放" if ok else "释放机械臂连接失败"}

    def _require(self):
        if not self.connected:
            return {"success": False, "connected": False, "sdkCalled": False, "error": "请先连接机械臂"}
        return None

    def _send(self, setters):
        self.lib.OnClearSet()
        result = True
        for setter in setters:
            result = bool(setter()) and result
        result = bool(self.lib.OnSetSend()) and result
        return result

    @staticmethod
    def _arr(values, count):
        values = values or []
        if len(values) != count:
            raise ValueError(f"参数需要 {count} 个数值")
        return (ctypes.c_double * count)(*[float(v) for v in values])

    def command(self, body):
        action = str(body.get("action", ""))
        arm = str(body.get("arm", "A")).upper()
        if action in ("connect",):
            return self.connect()
        if action in ("disconnect", "exit"):
            return self.release()
        if arm not in ("A", "B", "AB"):
            return {"success": False, "error": "arm 必须为 A、B 或 AB"}
        required = self._require()
        if required:
            return required
        arms = self._arms(arm)
        state = int(body.get("state", 0))
        vel = int(body.get("velRatio", 10))
        acc = int(body.get("accRatio", 10))

        if action in ("set_state", "disable"):
            target = 0 if action == "disable" else state
            ok = self._send([lambda a=a: self._call("OnSetTargetState", a, target) for a in arms])
            return {"success": ok, "connected": True, "sdkCalled": True, "state": target, "stateName": STATE_NAMES.get(target, str(target))}
        if action == "clear_error":
            ok = self._send([lambda a=a: (getattr(self.lib, f"OnClearErr_{a}")() or True) for a in arms])
            return {"success": ok, "connected": True, "sdkCalled": True}
        if action == "soft_stop":
            if arm == "AB":
                self.lib.OnEMG_AB()
            else:
                getattr(self.lib, f"OnEMG_{arm}")()
            return {"success": True, "connected": True, "sdkCalled": True, "stateName": "IDLE"}
        if action == "get_errors":
            errors = {}
            for a in arms:
                arr = (ctypes.c_long * 7)()
                getattr(self.lib, f"OnGetServoErr_{a}")(ctypes.byref(arr))
                errors[a] = [{"joint": i + 1, "code": hex(int(code)).upper()} for i, code in enumerate(arr) if int(code)]
            return {"success": True, "connected": True, "sdkCalled": True, "errors": errors, "hasError": any(errors.values())}
        if action == "set_joint_mode":
            ok = self._send([lambda a=a: self._call("OnSetJointLmt", a, vel, acc) and self._call("OnSetTargetState", a, 1) for a in arms])
            return {"success": ok, "connected": True, "sdkCalled": True, "stateName": "POSITION", "applied": {"velRatio": vel, "accRatio": acc}}
        if action in ("set_impedance_joint", "set_impedance_cart"):
            k = self._arr(body.get("stiffness"), 7)
            d = self._arr(body.get("damping"), 7)
            if action == "set_impedance_joint":
                def make(a):
                    return lambda: self._call("OnSetJointLmt", a, vel, acc) and self._call("OnSetJointKD", a, k, d) and self._call("OnSetTargetState", a, 3) and self._call("OnSetImpType", a, 1)
            else:
                rot_type = int(body.get("rotType", 0))
                rot = self._arr(body.get("cartCtrlPara") or [0] * 7, 7)
                def make(a):
                    return lambda: self._call("OnSetJointLmt", a, vel, acc) and self._call("OnSetCartKD", a, k, d, 2) and self._call("OnSetEefRot", a, rot_type, rot) and self._call("OnSetTargetState", a, 3) and self._call("OnSetImpType", a, 2)
            ok = self._send([make(a) for a in arms])
            return {"success": ok, "connected": True, "sdkCalled": True, "stateName": "TORQUE"}
        if action in ("joint_drag", "cart_drag", "exit_drag"):
            if action == "joint_drag":
                drag_type = 1
            elif action == "exit_drag":
                drag_type = 0
            else:
                drag_type = {"X": 2, "Y": 3, "Z": 4, "R": 5}.get(str(body.get("direction", "X")).upper(), 2)
            def make(a):
                def setter():
                    if action == "joint_drag":
                        return self._call("OnSetTargetState", a, 3) and self._call("OnSetImpType", a, 1)
                    if action == "cart_drag":
                        return self._call("OnSetTargetState", a, 3) and self._call("OnSetImpType", a, 2)
                    return True
                return lambda: setter() and self._call("OnSetDragSpace", a, drag_type)
            ok = self._send([make(a) for a in arms])
            return {"success": ok, "connected": True, "sdkCalled": True, "applied": {"direction": body.get("direction")} }
        if action == "set_tool":
            kine = self._arr(body.get("kinePara"), 6)
            dyn = self._arr(body.get("dynPara"), 10)
            ok = self._send([lambda a=a: self._call("OnSetTool", a, kine, dyn) for a in arms])
            return {"success": ok, "connected": True, "sdkCalled": True, "applied": {"massKg": float(dyn[0])}}
        return {"success": False, "connected": True, "sdkCalled": False, "error": "不支持的机械臂操作"}

    def close(self):
        with self.lock:
            if self.connected:
                try:
                    self.lib.OnRelease()
                except Exception:
                    pass
                self.connected = False


class Handler(BaseHTTPRequestHandler):
    controller = None

    def _json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.split("?", 1)[0] in ("/health", "/state"):
            self._json(200, {"ok": True, "connected": self.controller.connected})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/command":
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            self._json(200, self.controller.command(body))
        except Exception as exc:
            self._json(200, {"success": False, "sdkCalled": False, "error": str(exc)})

    def log_message(self, *_args):
        return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lib", default="/tmp/libMarvinSDK.so")
    parser.add_argument("--robot-ip", default="192.168.1.190")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3011)
    args = parser.parse_args()
    controller = MarvinController(args.lib, args.robot_ip)
    Handler.controller = controller
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    finally:
        controller.close()


if __name__ == "__main__":
    main()
