//! Arm the pet window for OS file-drags, then take drops through Tauri.
//!
//! A click-through pet is invisible to the platform drag destination (OLE
//! `WindowFromPoint` on Windows, `ignoresMouseEvents` on macOS), so
//! `onDragDropEvent` never fires. When an OS file-drag is in flight, click-through
//! drops for that span (and a short hold after button-up) so the webview can see
//! the drop. The webview listener is the cross-platform path; Windows also
//! registers an `IDropTarget` and emits `os_file_drop` because Tauri 2 does not
//! forward tao's parent-HWND file drops.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const FILE_DRAG_CHANNEL: &str = "file_drag";
pub const FILE_DROP_CHANNEL: &str = "os_file_drop";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileDragPayload {
    pub over_window: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileDropPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FileDropPayload {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<FileDropPoint>,
}

pub(crate) fn file_drop_payload(
    kind: &'static str,
    paths: Option<Vec<String>>,
    position: Option<(i32, i32)>,
) -> FileDropPayload {
    FileDropPayload {
        kind,
        paths,
        position: position.map(|(x, y)| FileDropPoint {
            x: f64::from(x),
            y: f64::from(y),
        }),
    }
}

/// True when `pt` sits in `[left, right) × [top, bottom)`.
pub(crate) fn cursor_in_rect(x: i32, y: i32, left: i32, top: i32, right: i32, bottom: i32) -> bool {
    x >= left && x < right && y >= top && y < bottom
}

pub(crate) fn cursor_in_inflated_rect(
    x: i32,
    y: i32,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    margin: i32,
) -> bool {
    cursor_in_rect(
        x,
        y,
        left - margin,
        top - margin,
        right + margin,
        bottom + margin,
    )
}

/// `EVENT_SYSTEM_DRAGDROPSTART` (0x000E) or `EVENT_OBJECT_DRAGSTART` (0x8021).
pub(crate) fn is_file_drag_start(event: u32) -> bool {
    event == 0x000E || event == 0x8021
}

/// `EVENT_SYSTEM_DRAGDROPEND` (0x000F) or UIA drag cancel/complete/dropped.
pub(crate) fn is_file_drag_end(event: u32) -> bool {
    event == 0x000F || event == 0x8022 || event == 0x8023 || event == 0x8026
}

/// Hold after the mouse button goes up so the drop can land on an armed window.
pub const FILE_DRAG_HOLD_MS: u64 = 300;

/// Physical px to arm click-through before the cursor reaches the outer frame.
pub const FILE_DRAG_ARM_MARGIN_PX: i32 = 320;

pub(crate) fn drag_active(hook: bool, ole_cursor: bool, hold_remaining_ms: u64) -> bool {
    hook || ole_cursor || hold_remaining_ms > 0
}

pub(crate) fn paths_include_dance(paths: &[String]) -> bool {
    paths.iter().any(|path| {
        let p = std::path::Path::new(path);
        crate::pkl_import::is_pkl_path(p) || crate::video_import::is_video_path(p)
    })
}

/// Dance files and held-card images. Explorer shows a deny cursor when this is false.
pub(crate) fn paths_accept_file_drop(paths: &[String]) -> bool {
    paths_include_dance(paths)
        || paths.iter().any(|path| {
            crate::image_drop::image_mime(std::path::Path::new(path)).is_some()
        })
}

/// Explorer / desktop classes a file-drag can start from (window or ancestor).
pub(crate) fn is_shell_window_class(class: &str) -> bool {
    matches!(
        class,
        "CabinetWClass"
            | "ExploreWClass"
            | "Progman"
            | "WorkerW"
            | "ShellTabWindowClass"
            | "SHELLDLL_DefView"
    )
}

pub(crate) fn drag_threshold_passed(dx: i32, dy: i32, threshold: i32) -> bool {
    dx.abs() > threshold || dy.abs() > threshold
}

/// Press started on the shell and the cursor has moved far enough to be a drag.
pub(crate) fn shell_file_drag(origin_is_shell: bool, threshold_passed: bool) -> bool {
    origin_is_shell && threshold_passed
}

pub(crate) fn image_name_is_explorer(path: &str) -> bool {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case("explorer.exe"))
}

/// Finder / Explorer drag pasteboard type identifiers.
#[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
pub(crate) fn is_file_drag_pasteboard_type(ty: &str) -> bool {
    let t = ty.trim();
    t.eq_ignore_ascii_case("public.file-url")
        || t.eq_ignore_ascii_case("NSFilenamesPboardType")
        || t.eq_ignore_ascii_case("public.file-promise")
        || t.to_ascii_lowercase()
            .starts_with("com.apple.pasteboard.promised-file")
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn emit_file_drag(app: &AppHandle, over_window: bool) {
    if let Err(err) = app.emit(FILE_DRAG_CHANNEL, FileDragPayload { over_window }) {
        log::warn!("file_drag_emit_failed error={err}");
    } else {
        log::info!("file_drag over_window={over_window}");
    }
}

#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
fn arm_pet_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let on_main = window.clone();
    let app = app.clone();
    if let Err(err) = window.run_on_main_thread(move || {
        if let Err(err) = crate::passthrough::apply_click_through(&on_main, false) {
            log::warn!("file_drag_capture_failed error={err}");
        }
        #[cfg(target_os = "windows")]
        drop_target::register(&app);
        #[cfg(not(target_os = "windows"))]
        {
            let _ = &app;
        }
        log::info!("file_drag_armed");
    }) {
        log::warn!("file_drag_capture_failed error={err}");
    }
}

pub fn start(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        drop_target::register(app);
        win::start(app.clone());
    }
    #[cfg(target_os = "macos")]
    {
        macos::start(app.clone());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = app;
    }
}

pub(crate) fn next_hold_remaining_ms(
    hook: bool,
    ole_cursor: bool,
    prev_ms: u64,
    elapsed_ms: u64,
    hold_ms: u64,
) -> u64 {
    if hook || ole_cursor {
        hold_ms
    } else {
        prev_ms.saturating_sub(elapsed_ms)
    }
}

#[cfg(target_os = "windows")]
mod drop_target {
    use super::{file_drop_payload, paths_accept_file_drop, FileDropPayload, FILE_DROP_CHANNEL};
    use std::cell::{Cell, RefCell};
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::ptr;
    use tauri::{AppHandle, Emitter, Manager};
    use windows::core::{implement, Ref, BOOL};
    use windows::Win32::Foundation::{HWND, LPARAM, POINT, POINTL};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::{
        IDropTarget, IDropTarget_Impl, RegisterDragDrop, RevokeDragDrop, CF_HDROP, DROPEFFECT,
        DROPEFFECT_COPY, DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

    thread_local! {
        static TARGETS: RefCell<Vec<IDropTarget>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) fn register(app: &AppHandle) {
        register_on_thread(app);
    }

    fn hdrop_format() -> FORMATETC {
        FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        }
    }

    fn collect_hwnds(parent: HWND) -> Vec<HWND> {
        let mut hwnds = vec![parent];
        unsafe {
            let _ = EnumChildWindows(
                Some(parent),
                Some(enum_child_proc),
                LPARAM(&mut hwnds as *mut Vec<HWND> as isize),
            );
        }
        hwnds
    }

    unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let hwnds = &mut *(lparam.0 as *mut Vec<HWND>);
        hwnds.push(hwnd);
        BOOL(1)
    }

    fn register_on_thread(app: &AppHandle) {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        let Ok(raw) = window.hwnd() else {
            return;
        };
        let client_hwnd = HWND(raw.0);
        let mut live = Vec::new();
        for hwnd in collect_hwnds(client_hwnd) {
            let target: IDropTarget = FileDropTarget {
                client_hwnd,
                app: app.clone(),
                cursor_effect: Cell::new(DROPEFFECT_NONE),
                enter_is_valid: Cell::new(false),
            }
            .into();
            let _ = unsafe { RevokeDragDrop(hwnd) };
            if unsafe { RegisterDragDrop(hwnd, &target) }.is_ok() {
                live.push(target);
            }
        }
        let count = live.len();
        TARGETS.with(|slot| {
            *slot.borrow_mut() = live;
        });
        if count > 0 {
            log::info!("file_drop_target_listening count={count}");
        } else {
            log::warn!("file_drop_target_failed error=no hwnd accepted RegisterDragDrop");
        }
    }

    #[implement(IDropTarget)]
    struct FileDropTarget {
        client_hwnd: HWND,
        app: AppHandle,
        cursor_effect: Cell<DROPEFFECT>,
        enter_is_valid: Cell<bool>,
    }

    impl FileDropTarget {
        fn emit(&self, payload: FileDropPayload) {
            if payload.kind != "over" {
                log::info!("os_file_drop type={}", payload.kind);
            }
            if let Err(err) = self.app.emit(FILE_DROP_CHANNEL, &payload) {
                log::warn!("file_drop_emit_failed error={err}");
            }
        }

        fn client_point(&self, pt: &POINTL) -> (i32, i32) {
            let mut client = POINT { x: pt.x, y: pt.y };
            let _ = unsafe { ScreenToClient(self.client_hwnd, &mut client) };
            (client.x, client.y)
        }

        fn query_hdrop(data_obj: &IDataObject) -> bool {
            unsafe { data_obj.QueryGetData(&hdrop_format()) }.is_ok()
        }

        fn paths_from_data(data_obj: &IDataObject) -> Option<Vec<String>> {
            let medium = unsafe { data_obj.GetData(&hdrop_format()) }.ok()?;
            // SAFETY: CF_HDROP + TYMED_HGLOBAL, so the union arm is hGlobal.
            let hdrop = HDROP(unsafe { medium.u.hGlobal.0 as _ });
            let item_count = unsafe { DragQueryFileW(hdrop, 0xFFFFFFFF, None) };
            let mut paths = Vec::with_capacity(item_count as usize);
            for i in 0..item_count {
                let character_count = unsafe { DragQueryFileW(hdrop, i, None) } as usize;
                let mut path_buf = vec![0; character_count + 1];
                unsafe { DragQueryFileW(hdrop, i, Some(&mut path_buf)) };
                let path = OsString::from_wide(&path_buf[..character_count]);
                paths.push(path.to_string_lossy().into_owned());
            }
            std::mem::forget(medium);
            Some(paths)
        }
    }

    #[allow(non_snake_case)]
    impl IDropTarget_Impl for FileDropTarget_Impl {
        fn DragEnter(
            &self,
            pDataObj: Ref<'_, IDataObject>,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            let Some(obj) = pDataObj.as_ref() else {
                self.enter_is_valid.set(false);
                self.cursor_effect.set(DROPEFFECT_NONE);
                unsafe { *pdwEffect = DROPEFFECT_NONE };
                return Ok(());
            };
            let paths = FileDropTarget::paths_from_data(obj);
            let valid = match &paths {
                Some(p) if p.is_empty() => FileDropTarget::query_hdrop(obj),
                Some(p) => paths_accept_file_drop(p),
                None => FileDropTarget::query_hdrop(obj),
            };
            self.enter_is_valid.set(valid);
            let effect = if valid {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
            self.cursor_effect.set(effect);
            unsafe { *pdwEffect = effect };
            if valid {
                let position = self.client_point(pt);
                self.emit(file_drop_payload(
                    "enter",
                    Some(paths.unwrap_or_default()),
                    Some(position),
                ));
            }
            Ok(())
        }

        fn DragOver(
            &self,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            _pt: &POINTL,
            pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            unsafe { *pdwEffect = self.cursor_effect.get() };
            Ok(())
        }

        fn DragLeave(&self) -> windows::core::Result<()> {
            if self.enter_is_valid.get() {
                self.emit(file_drop_payload("leave", None, None));
            }
            self.enter_is_valid.set(false);
            Ok(())
        }

        fn Drop(
            &self,
            pDataObj: Ref<'_, IDataObject>,
            _grfKeyState: MODIFIERKEYS_FLAGS,
            pt: &POINTL,
            _pdwEffect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            if !self.enter_is_valid.get() {
                return Ok(());
            }
            let position = self.client_point(pt);
            if let Some(obj) = pDataObj.as_ref() {
                if let Some(paths) = FileDropTarget::paths_from_data(obj) {
                    self.emit(file_drop_payload("drop", Some(paths), Some(position)));
                }
            }
            self.enter_is_valid.set(false);
            Ok(())
        }
    }
}

#[cfg(target_os = "windows")]
mod win {
    use super::{
        cursor_in_inflated_rect, drag_active, drag_threshold_passed, emit_file_drag,
        image_name_is_explorer, is_file_drag_end, is_file_drag_start, is_shell_window_class,
        next_hold_remaining_ms, shell_file_drag, FILE_DRAG_ARM_MARGIN_PX, FILE_DRAG_HOLD_MS,
    };
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::thread;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use windows::Win32::Foundation::{CloseHandle, HWND, POINT, RECT};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetAncestor, GetClassNameW, GetCursorInfo, GetCursorPos,
        GetSystemMetrics, GetWindowRect, GetWindowThreadProcessId, LoadCursorW, PeekMessageW,
        TranslateMessage, WindowFromPoint, CURSORINFO, EVENT_OBJECT_DRAGDROPPED,
        EVENT_OBJECT_DRAGSTART, EVENT_SYSTEM_DRAGDROPEND, EVENT_SYSTEM_DRAGDROPSTART, GA_PARENT,
        GA_ROOT, IDC_APPSTARTING, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_HELP, IDC_IBEAM, IDC_SIZEALL,
        IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, IDC_UPARROW, IDC_WAIT, MSG, PM_REMOVE,
        SM_CXDRAG, SM_CYDRAG, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS,
    };

    #[derive(Default)]
    struct ShellDragWatch {
        down: bool,
        origin: POINT,
        origin_is_shell: bool,
        origin_class: String,
        passed: bool,
    }

    impl ShellDragWatch {
        fn update(
            &mut self,
            down: bool,
            current: POINT,
            classify: impl FnOnce() -> (bool, String),
        ) -> bool {
            if !down {
                *self = Self::default();
                return false;
            }
            if !self.down {
                self.down = true;
                self.origin = current;
                let (is_shell, class) = classify();
                self.origin_is_shell = is_shell;
                self.origin_class = class;
                self.passed = false;
            }
            if !self.passed {
                self.passed = drag_threshold_passed(
                    current.x - self.origin.x,
                    current.y - self.origin.y,
                    drag_threshold_px(),
                );
            }
            shell_file_drag(self.origin_is_shell, self.passed)
        }
    }

    static DRAGGING: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn on_win_event(
        _hook: HWINEVENTHOOK,
        event: u32,
        _hwnd: HWND,
        _id_object: i32,
        _id_child: i32,
        _id_event_thread: u32,
        _dwms_event_time: u32,
    ) {
        if is_file_drag_start(event) {
            DRAGGING.store(true, Ordering::SeqCst);
        } else if is_file_drag_end(event) {
            DRAGGING.store(false, Ordering::SeqCst);
        }
    }

    fn hook(min: u32, max: u32) -> HWINEVENTHOOK {
        // SAFETY: OUTOFCONTEXT callback runs on this thread via the message pump in `start`.
        unsafe {
            SetWinEventHook(
                min,
                max,
                None,
                Some(on_win_event),
                0,
                0,
                WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
            )
        }
    }

    pub(super) fn start(app: AppHandle) {
        thread::Builder::new()
            .name("file_drag_win".into())
            .spawn(move || {
                let hook_sys = hook(EVENT_SYSTEM_DRAGDROPSTART, EVENT_SYSTEM_DRAGDROPEND);
                let hook_obj = hook(EVENT_OBJECT_DRAGSTART, EVENT_OBJECT_DRAGDROPPED);
                if hook_sys.is_invalid() && hook_obj.is_invalid() {
                    log::warn!("file_drag_hook_failed");
                }
                log::info!("file_drag_listening");
                let mut last_dragging = false;
                let mut hold_remaining_ms = 0_u64;
                let mut shell_watch = ShellDragWatch::default();
                let mut msg = MSG::default();
                loop {
                    unsafe {
                        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                    let hook = DRAGGING.load(Ordering::SeqCst);
                    let pt = cursor_point();
                    let down = lbutton_down();
                    let shell = shell_watch.update(down, pt, || classify_press_origin(&app, pt));
                    let near = cursor_near_main(&app, FILE_DRAG_ARM_MARGIN_PX);
                    let ole_near = ole_drag_cursor() && near;
                    let armed = hook || shell;
                    let tick_ms = if armed || ole_near || hold_remaining_ms > 0 {
                        16
                    } else {
                        50
                    };
                    hold_remaining_ms = next_hold_remaining_ms(
                        armed,
                        ole_near,
                        hold_remaining_ms,
                        tick_ms,
                        FILE_DRAG_HOLD_MS,
                    );
                    let dragging = drag_active(armed, ole_near, hold_remaining_ms);
                    if dragging && !last_dragging {
                        super::arm_pet_window(&app);
                    }
                    if dragging != last_dragging {
                        log::info!(
                            "file_drag_active {dragging} hook={hook} shell={shell} origin={}",
                            shell_watch.origin_class
                        );
                        last_dragging = dragging;
                        emit_file_drag(&app, dragging);
                    }
                    thread::sleep(Duration::from_millis(tick_ms));
                }
            })
            .expect("failed to spawn file_drag_win thread");
    }

    fn lbutton_down() -> bool {
        unsafe { GetAsyncKeyState(i32::from(VK_LBUTTON.0)) < 0 }
    }

    fn cursor_point() -> POINT {
        let mut pt = POINT::default();
        let _ = unsafe { GetCursorPos(&mut pt) };
        pt
    }

    fn drag_threshold_px() -> i32 {
        unsafe {
            GetSystemMetrics(SM_CXDRAG)
                .max(GetSystemMetrics(SM_CYDRAG))
                .max(4)
        }
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }

    fn classify_press_origin(app: &AppHandle, pt: POINT) -> (bool, String) {
        let hwnd = unsafe { WindowFromPoint(pt) };
        if hwnd.0.is_null() {
            return (false, String::new());
        }
        if hwnd_is_ours(app, hwnd) {
            return (false, class_name(hwnd));
        }
        let mut current = hwnd;
        for _ in 0..24 {
            let class = class_name(current);
            if is_shell_window_class(&class) {
                return (true, class);
            }
            let parent = unsafe { GetAncestor(current, GA_PARENT) };
            if parent.0.is_null() || parent == current {
                break;
            }
            current = parent;
        }
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        let target = if root.0.is_null() { hwnd } else { root };
        let class = class_name(target);
        let is_shell = is_shell_window_class(&class)
            || process_image_path(target)
                .as_deref()
                .is_some_and(image_name_is_explorer)
            || process_image_path(hwnd)
                .as_deref()
                .is_some_and(image_name_is_explorer);
        (is_shell, class)
    }

    fn process_image_path(hwnd: HWND) -> Option<String> {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 {
            return None;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
        };
        let _ = unsafe { CloseHandle(process) };
        ok.ok()?;
        let os = OsString::from_wide(&buf[..size as usize]);
        Some(os.to_string_lossy().into_owned())
    }

    fn hwnd_is_ours(app: &AppHandle, hwnd: HWND) -> bool {
        let Some(window) = app.get_webview_window("main") else {
            return false;
        };
        let Ok(raw) = window.hwnd() else {
            return false;
        };
        let main = HWND(raw.0);
        let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
        let target = if root.0.is_null() { hwnd } else { root };
        target == main
    }

    fn ole_drag_cursor() -> bool {
        if !lbutton_down() {
            return false;
        }
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetCursorInfo(&mut info) }.is_err() {
            return false;
        }
        !idle_pointer_cursors()
            .iter()
            .any(|&cursor| cursor == info.hCursor.0 as isize)
    }

    fn idle_pointer_cursors() -> &'static [isize] {
        static C: OnceLock<Vec<isize>> = OnceLock::new();
        C.get_or_init(|| {
            [
                IDC_ARROW,
                IDC_IBEAM,
                IDC_HAND,
                IDC_WAIT,
                IDC_APPSTARTING,
                IDC_SIZEALL,
                IDC_SIZENESW,
                IDC_SIZENS,
                IDC_SIZENWSE,
                IDC_SIZEWE,
                IDC_UPARROW,
                IDC_HELP,
                IDC_CROSS,
            ]
            .into_iter()
            .filter_map(|id| unsafe { LoadCursorW(None, id).ok().map(|c| c.0 as isize) })
            .collect()
        })
    }

    fn cursor_near_main(app: &AppHandle, margin: i32) -> bool {
        let Some(window) = app.get_webview_window("main") else {
            return false;
        };
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let mut rect = RECT::default();
        let mut pt = POINT::default();
        unsafe {
            if GetWindowRect(HWND(hwnd.0), &mut rect).is_err() {
                return false;
            }
            if GetCursorPos(&mut pt).is_err() {
                return false;
            }
        }
        cursor_in_inflated_rect(
            pt.x,
            pt.y,
            rect.left,
            rect.top,
            rect.right,
            rect.bottom,
            margin,
        )
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{
        drag_active, emit_file_drag, is_file_drag_pasteboard_type, next_hold_remaining_ms,
        FILE_DRAG_HOLD_MS,
    };
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
    use std::thread;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(stateID: i32, button: u32) -> bool;
    }

    const CG_EVENT_SOURCE_STATE_COMBINED: i32 = 0;
    const CG_MOUSE_BUTTON_LEFT: u32 = 0;
    const TICK_MS: u64 = 50;

    fn lbutton_down() -> bool {
        unsafe { CGEventSourceButtonState(CG_EVENT_SOURCE_STATE_COMBINED, CG_MOUSE_BUTTON_LEFT) }
    }

    fn drag_pasteboard_has_files() -> bool {
        unsafe {
            let pb = NSPasteboard::pasteboardWithName(NSPasteboardNameDrag);
            let Some(types) = pb.types() else {
                return false;
            };
            types
                .iter()
                .any(|ty| is_file_drag_pasteboard_type(&ty.to_string()))
        }
    }

    pub(super) fn start(app: AppHandle) {
        thread::Builder::new()
            .name("file_drag_macos".into())
            .spawn(move || {
                log::info!("file_drag_listening");
                let mut last_dragging = false;
                let mut hold_remaining_ms = 0_u64;
                loop {
                    let down = lbutton_down();
                    let pasteboard = drag_pasteboard_has_files();
                    let armed = down && pasteboard;
                    hold_remaining_ms = next_hold_remaining_ms(
                        armed,
                        false,
                        hold_remaining_ms,
                        TICK_MS,
                        FILE_DRAG_HOLD_MS,
                    );
                    let dragging = drag_active(armed, false, hold_remaining_ms);
                    if dragging && !last_dragging {
                        super::arm_pet_window(&app);
                    }
                    if dragging != last_dragging {
                        log::info!("file_drag_active {dragging} pasteboard={pasteboard}");
                        last_dragging = dragging;
                        emit_file_drag(&app, dragging);
                    }
                    thread::sleep(Duration::from_millis(TICK_MS));
                }
            })
            .expect("failed to spawn file_drag_macos thread");
    }
}

#[cfg(test)]
mod tests {
    use super::{
        cursor_in_inflated_rect, cursor_in_rect, drag_active, drag_threshold_passed,
        file_drop_payload, image_name_is_explorer, is_file_drag_end, is_file_drag_pasteboard_type,
        is_file_drag_start, is_shell_window_class, next_hold_remaining_ms, paths_accept_file_drop,
        paths_include_dance,
        shell_file_drag, FILE_DRAG_ARM_MARGIN_PX, FILE_DRAG_HOLD_MS, FILE_DROP_CHANNEL,
    };

    #[test]
    fn drag_stays_active_through_hold_after_button_up() {
        assert!(drag_active(true, false, 0));
        assert!(drag_active(false, true, 0));
        assert!(drag_active(false, false, 1));
        assert!(!drag_active(false, false, 0));
        assert_eq!(
            next_hold_remaining_ms(true, false, 0, 16, FILE_DRAG_HOLD_MS),
            FILE_DRAG_HOLD_MS
        );
        assert_eq!(next_hold_remaining_ms(false, false, 300, 16, 300), 284);
        assert_eq!(next_hold_remaining_ms(false, false, 10, 16, 300), 0);
    }

    #[test]
    fn shell_window_classes_are_explorer_and_desktop() {
        assert!(is_shell_window_class("CabinetWClass"));
        assert!(is_shell_window_class("ExploreWClass"));
        assert!(is_shell_window_class("Progman"));
        assert!(is_shell_window_class("WorkerW"));
        assert!(is_shell_window_class("ShellTabWindowClass"));
        assert!(is_shell_window_class("SHELLDLL_DefView"));
        assert!(!is_shell_window_class("Chrome_WidgetWin_1"));
        assert!(!is_shell_window_class("SysListView32"));
        assert!(!is_shell_window_class(""));
    }

    #[test]
    fn shell_file_drag_needs_origin_and_threshold() {
        assert!(!drag_threshold_passed(4, 0, 4));
        assert!(drag_threshold_passed(5, 0, 4));
        assert!(drag_threshold_passed(0, -5, 4));
        assert!(!shell_file_drag(true, false));
        assert!(!shell_file_drag(false, true));
        assert!(shell_file_drag(true, true));
    }

    #[test]
    fn explorer_image_name_ignores_path_and_case() {
        assert!(image_name_is_explorer(r"C:\Windows\Explorer.EXE"));
        assert!(image_name_is_explorer(r"C:\Windows\explorer.exe"));
        assert!(!image_name_is_explorer(r"C:\Program Files\app.exe"));
        assert!(!image_name_is_explorer(""));
    }

    #[test]
    fn finder_pasteboard_types_mark_a_file_drag() {
        assert!(is_file_drag_pasteboard_type("public.file-url"));
        assert!(is_file_drag_pasteboard_type("NSFilenamesPboardType"));
        assert!(is_file_drag_pasteboard_type("public.file-promise"));
        assert!(is_file_drag_pasteboard_type(
            "com.apple.pasteboard.promised-file-url"
        ));
        assert!(is_file_drag_pasteboard_type(
            "com.apple.pasteboard.promised-file-content-type"
        ));
        assert!(!is_file_drag_pasteboard_type("public.utf8-plain-text"));
        assert!(!is_file_drag_pasteboard_type(""));
    }

    #[test]
    fn paths_include_dance_accepts_pkl_and_mp4_mov() {
        assert!(paths_include_dance(&[r"C:\clips\Spin.PKL".into()]));
        assert!(paths_include_dance(&["/tmp/note.txt".into(), "/tmp/a.pkl".into()]));
        assert!(paths_include_dance(&["/tmp/clip.mp4".into()]));
        assert!(paths_include_dance(&[r"C:\clips\Dance.MOV".into()]));
        assert!(!paths_include_dance(&["/tmp/clip.webm".into()]));
        assert!(!paths_include_dance(&["/tmp/clip.vrma".into()]));
        assert!(!paths_include_dance(&[]));
        assert!(!paths_include_dance(&[r"C:\shots\Card.PNG".into()]));
    }

    #[test]
    fn paths_accept_file_drop_includes_held_images() {
        assert!(paths_accept_file_drop(&[r"C:\shots\Card.PNG".into()]));
        assert!(paths_accept_file_drop(&["/tmp/a.jpg".into()]));
        assert!(paths_accept_file_drop(&["/tmp/a.jpeg".into()]));
        assert!(paths_accept_file_drop(&["/tmp/a.webp".into()]));
        assert!(paths_accept_file_drop(&["/tmp/a.gif".into()]));
        assert!(paths_accept_file_drop(&["/tmp/note.txt".into(), "/tmp/a.pkl".into()]));
        assert!(!paths_accept_file_drop(&["/tmp/a.txt".into()]));
        assert!(!paths_accept_file_drop(&[]));
    }

    #[test]
    fn cursor_in_rect_uses_half_open_bounds() {
        assert!(cursor_in_rect(0, 0, 0, 0, 100, 200));
        assert!(cursor_in_rect(99, 199, 0, 0, 100, 200));
        assert!(!cursor_in_rect(100, 0, 0, 0, 100, 200));
        assert!(!cursor_in_rect(0, 200, 0, 0, 100, 200));
        assert!(!cursor_in_rect(-1, 10, 0, 0, 100, 200));
    }

    #[test]
    fn inflated_rect_arms_before_the_frame() {
        assert!(!cursor_in_rect(0, 0, 100, 100, 200, 200));
        assert!(cursor_in_inflated_rect(0, 0, 100, 100, 200, 200, 100));
        assert!(!cursor_in_inflated_rect(0, 0, 100, 100, 200, 200, 50));
        assert!(cursor_in_inflated_rect(
            99,
            100,
            100,
            100,
            200,
            200,
            FILE_DRAG_ARM_MARGIN_PX
        ));
    }

    #[test]
    fn file_drag_start_end_match_winuser_ids() {
        assert!(is_file_drag_start(0x000E));
        assert!(is_file_drag_start(0x8021));
        assert!(!is_file_drag_start(0x000A));
        assert!(!is_file_drag_start(0xA7));
        assert!(is_file_drag_end(0x000F));
        assert!(is_file_drag_end(0x8022));
        assert!(is_file_drag_end(0x8023));
        assert!(is_file_drag_end(0x8026));
        assert!(!is_file_drag_end(0x8024));
    }

    #[test]
    fn file_drop_payload_matches_tauri_drag_drop_shape() {
        let json = serde_json::to_value(file_drop_payload(
            "drop",
            Some(vec![r"C:\clips\spin.pkl".into()]),
            Some((80, 160)),
        ))
        .unwrap();
        assert_eq!(json["type"], "drop");
        assert_eq!(json["paths"][0], r"C:\clips\spin.pkl");
        assert_eq!(json["position"]["x"], 80.0);
        assert_eq!(json["position"]["y"], 160.0);
        assert_eq!(FILE_DROP_CHANNEL, "os_file_drop");
        let leave = serde_json::to_value(file_drop_payload("leave", None, None)).unwrap();
        assert_eq!(leave["type"], "leave");
        assert!(leave.get("paths").is_none());
        assert!(leave.get("position").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn msaa_and_uia_drag_event_ids_match_winuser() {
        use windows::Win32::UI::WindowsAndMessaging::{
            EVENT_OBJECT_DRAGCANCEL, EVENT_OBJECT_DRAGCOMPLETE, EVENT_OBJECT_DRAGDROPPED,
            EVENT_OBJECT_DRAGENTER, EVENT_OBJECT_DRAGSTART, EVENT_SYSTEM_DRAGDROPEND,
            EVENT_SYSTEM_DRAGDROPSTART,
        };
        assert_eq!(EVENT_SYSTEM_DRAGDROPSTART, 0x000E);
        assert_eq!(EVENT_SYSTEM_DRAGDROPEND, 0x000F);
        assert_eq!(EVENT_OBJECT_DRAGSTART, 0x8021);
        assert_eq!(EVENT_OBJECT_DRAGCANCEL, 0x8022);
        assert_eq!(EVENT_OBJECT_DRAGCOMPLETE, 0x8023);
        assert_eq!(EVENT_OBJECT_DRAGENTER, 0x8024);
        assert_eq!(EVENT_OBJECT_DRAGDROPPED, 0x8026);
        assert!(is_file_drag_start(EVENT_SYSTEM_DRAGDROPSTART));
        assert!(is_file_drag_start(EVENT_OBJECT_DRAGSTART));
        assert!(is_file_drag_end(EVENT_OBJECT_DRAGDROPPED));
        assert!(!is_file_drag_end(EVENT_OBJECT_DRAGENTER));
    }
}
