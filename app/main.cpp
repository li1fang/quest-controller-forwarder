#include <jni.h>
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <time.h>
#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
#include <android/log.h>
#include <android/native_activity.h>
#include <android/window.h>
#include <android_native_app_glue.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cerrno>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <iomanip>
#include <locale>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
constexpr int kPort = 19427;
constexpr const char* kTag = "QuestUSB";

void log(const std::string& value) { __android_log_write(ANDROID_LOG_INFO, kTag, value.c_str()); }
void check(XrResult result, const char* operation) {
    if (XR_FAILED(result)) throw std::runtime_error(std::string(operation) + ": XrResult " + std::to_string(result));
}
int64_t monotonicNs() {
    timespec value{};
    clock_gettime(CLOCK_MONOTONIC, &value);
    return int64_t(value.tv_sec) * 1000000000LL + value.tv_nsec;
}
std::string quote(const std::string& value) {
    std::string out = "\"";
    for (unsigned char ch : value) {
        if (ch == '"' || ch == '\\') { out += '\\'; out += char(ch); }
        else if (ch < 32) out += ' ';
        else out += char(ch);
    }
    return out + '"';
}
const char* stateName(XrSessionState state) {
    switch (state) {
        case XR_SESSION_STATE_IDLE: return "idle";
        case XR_SESSION_STATE_READY: return "ready";
        case XR_SESSION_STATE_SYNCHRONIZED: return "synchronized";
        case XR_SESSION_STATE_VISIBLE: return "visible";
        case XR_SESSION_STATE_FOCUSED: return "focused";
        case XR_SESSION_STATE_STOPPING: return "stopping";
        case XR_SESSION_STATE_LOSS_PENDING: return "loss_pending";
        case XR_SESSION_STATE_EXITING: return "exiting";
        default: return "unknown";
    }
}

// The XR thread only replaces the latest frame. Slow/disconnected USB never blocks tracking.
class Sender {
public:
    explicit Sender(android_app* app) : app_(app), thread_([this] { run(); }) {}
    ~Sender() {
        stop_ = true;
        changed_.notify_all();
        thread_.join();
    }
    void publish(std::string packet) {
        std::lock_guard<std::mutex> lock(mutex_);
        latest_ = std::move(packet) + '\n';
        ++generation_;
        changed_.notify_all();
    }
private:
    int connectPc() {
        const int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
        if (fd < 0) return -1;
        fcntl(fd, F_SETFL, O_NONBLOCK);
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = htons(kPort);
        inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
        int result = connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address));
        if (result < 0 && errno == EINPROGRESS) {
            pollfd descriptor{fd, POLLOUT, 0};
            result = poll(&descriptor, 1, 500);
            int error = 0;
            socklen_t size = sizeof(error);
            if (result <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) < 0 || error) result = -1;
            else result = 0;
        }
        if (result < 0) { close(fd); return -1; }
        return fd;
    }
    bool sendPacket(int fd, const std::string& packet) {
        size_t offset = 0;
        const int64_t deadline = monotonicNs() + 500000000LL;
        while (offset < packet.size() && !stop_) {
            const ssize_t count = send(fd, packet.data() + offset, packet.size() - offset, MSG_NOSIGNAL);
            if (count > 0) offset += size_t(count);
            else if (count < 0 && errno == EINTR) continue;
            else if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                if (monotonicNs() > deadline) return false;
                pollfd descriptor{fd, POLLOUT, 0};
                if (poll(&descriptor, 1, 50) < 0 && errno != EINTR) return false;
            } else return false;
        }
        return offset == packet.size();
    }
    void run() {
        JNIEnv* env = nullptr;
        if (app_->activity->vm->AttachCurrentThread(&env, nullptr) != JNI_OK) { log("Cannot attach sender thread"); return; }
        // NativeActivity's class loader can resolve our packaged helper on this native thread.
        jclass activityClass = env->GetObjectClass(app_->activity->clazz);
        jobject loader = env->CallObjectMethod(app_->activity->clazz, env->GetMethodID(activityClass, "getClassLoader", "()Ljava/lang/ClassLoader;"));
        jclass loaderClass = env->FindClass("java/lang/ClassLoader");
        jstring helperName = env->NewStringUTF("dev.quest.usbforwarder.LanTransport");
        jclass helperClass = static_cast<jclass>(env->CallObjectMethod(loader, env->GetMethodID(loaderClass, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;"), helperName));
        if (env->ExceptionCheck() || !helperClass) { env->ExceptionClear(); log("LAN helper load failed; sender stopped"); app_->activity->vm->DetachCurrentThread(); return; }
        jobject helper = env->NewObject(helperClass, env->GetMethodID(helperClass, "<init>", "(Landroid/app/Activity;)V"), app_->activity->clazz);
        const auto configured = env->GetMethodID(helperClass, "isConfigured", "()Z");
        const auto sendLan = env->GetMethodID(helperClass, "send", "(Ljava/lang/String;)Z");
        const auto closeLan = env->GetMethodID(helperClass, "close", "()V");
        const bool lan = helper && env->CallBooleanMethod(helper, configured);
        if (env->ExceptionCheck() || !helper) { env->ExceptionClear(); log("LAN helper initialization failed; sender stopped"); app_->activity->vm->DetachCurrentThread(); return; }
        int fd = -1;
        uint64_t sent = 0;
        while (!stop_) {
            if (!lan && fd < 0) {
                fd = connectPc();
                if (fd < 0) {
                    std::unique_lock<std::mutex> lock(mutex_);
                    changed_.wait_for(lock, std::chrono::seconds(1), [this] { return stop_.load(); });
                    continue;
                }
                sent = 0;
                log("Connected to PC via adb reverse");
            }
            std::string packet;
            uint64_t generation;
            {
                std::unique_lock<std::mutex> lock(mutex_);
                changed_.wait_for(lock, std::chrono::milliseconds(250), [this, sent] { return stop_ || generation_ != sent; });
                if (stop_) break;
                if (generation_ == sent) continue;
                packet = latest_;
                generation = generation_;
            }
            if (lan) {
                jstring message = env->NewStringUTF(packet.c_str());
                const bool ok = env->CallBooleanMethod(helper, sendLan, message);
                env->DeleteLocalRef(message);
                if (env->ExceptionCheck()) env->ExceptionClear();
                if (ok) sent = generation;
                else {
                    std::unique_lock<std::mutex> lock(mutex_);
                    changed_.wait_for(lock, std::chrono::seconds(1), [this] { return stop_.load(); });
                }
            } else if (!sendPacket(fd, packet)) { close(fd); fd = -1; }
            else sent = generation;
        }
        if (fd >= 0) close(fd);
        env->CallVoidMethod(helper, closeLan);
        if (env->ExceptionCheck()) env->ExceptionClear();
        app_->activity->vm->DetachCurrentThread();
    }
    android_app* app_;
    std::atomic<bool> stop_{false};
    std::mutex mutex_;
    std::condition_variable changed_;
    std::string latest_;
    uint64_t generation_ = 0;
    std::thread thread_;
};

struct Eye {
    XrSwapchain swapchain = XR_NULL_HANDLE;
    int32_t width = 512, height = 512;
    std::vector<XrSwapchainImageOpenGLESKHR> images;
};
struct Hand {
    bool poseActive = false;
    XrSpaceLocation location{XR_TYPE_SPACE_LOCATION};
    XrSpaceVelocity velocity{XR_TYPE_SPACE_VELOCITY};
};

class Forwarder {
public:
    explicit Forwarder(android_app* app) : app_(app), sender_(app) {}
    ~Forwarder() { cleanup(); }
    void onCommand(int32_t command) {
        if (command == APP_CMD_RESUME) resumed_ = true;
        if (command == APP_CMD_PAUSE) resumed_ = false;
    }
    void run() {
        status("starting");
        while (!app_->destroyRequested && !exit_) {
            int events = 0;
            android_poll_source* source = nullptr;
            while (ALooper_pollOnce(running_ ? 0 : 20, nullptr, &events, reinterpret_cast<void**>(&source)) >= 0) {
                if (source) source->process(app_, source);
                if (app_->destroyRequested) break;
            }
            if (app_->destroyRequested) break;
            if (!initialized_ && app_->window && resumed_) initialize();
            if (initialized_) pollEvents();
            if (running_) frame();
            else if (monotonicNs() - lastHeartbeat_ > 500000000LL) {
                status(stateName(state_));
                lastHeartbeat_ = monotonicNs();
            }
        }
        status("stopped");
    }
    void error(const std::string& reason) {
        log("ERROR: " + reason);
        status("error", reason);
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
private:
    XrPath path(const char* text) {
        XrPath value = XR_NULL_PATH;
        check(xrStringToPath(instance_, text, &value), "xrStringToPath");
        return value;
    }
    template <typename Function> Function function(const char* name) {
        PFN_xrVoidFunction result = nullptr;
        check(xrGetInstanceProcAddr(instance_, name, &result), name);
        if (!result) throw std::runtime_error(std::string("Missing function ") + name);
        return reinterpret_cast<Function>(result);
    }
    XrAction action(const char* name, XrActionType type) {
        XrActionCreateInfo info{XR_TYPE_ACTION_CREATE_INFO};
        std::strncpy(info.actionName, name, sizeof(info.actionName) - 1);
        std::strncpy(info.localizedActionName, name, sizeof(info.localizedActionName) - 1);
        info.actionType = type;
        info.countSubactionPaths = 2;
        info.subactionPaths = hands_.data();
        XrAction result = XR_NULL_HANDLE;
        check(xrCreateAction(actionSet_, &info, &result), "xrCreateAction");
        return result;
    }
    void initialize() {
        log("Initializing native OpenXR forwarder");
        PFN_xrVoidFunction raw = nullptr;
        check(xrGetInstanceProcAddr(XR_NULL_HANDLE, "xrInitializeLoaderKHR", &raw), "xrInitializeLoaderKHR lookup");
        XrLoaderInitInfoAndroidKHR loaderInfo{XR_TYPE_LOADER_INIT_INFO_ANDROID_KHR};
        loaderInfo.applicationVM = app_->activity->vm;
        loaderInfo.applicationContext = app_->activity->clazz;
        check(reinterpret_cast<PFN_xrInitializeLoaderKHR>(raw)(reinterpret_cast<XrLoaderInitInfoBaseHeaderKHR*>(&loaderInfo)), "xrInitializeLoaderKHR");
        uint32_t count = 0;
        check(xrEnumerateInstanceExtensionProperties(nullptr, 0, &count, nullptr), "enumerate extensions");
        std::vector<XrExtensionProperties> available(count, {XR_TYPE_EXTENSION_PROPERTIES});
        check(xrEnumerateInstanceExtensionProperties(nullptr, count, &count, available.data()), "enumerate extensions");
        std::vector<const char*> extensions{XR_KHR_ANDROID_CREATE_INSTANCE_EXTENSION_NAME, XR_KHR_OPENGL_ES_ENABLE_EXTENSION_NAME};
        const bool proProfile = std::any_of(available.begin(), available.end(), [](const auto& item) {
            return std::strcmp(item.extensionName, XR_FB_TOUCH_CONTROLLER_PRO_EXTENSION_NAME) == 0;
        });
        const bool timeConversion = std::any_of(available.begin(), available.end(), [](const auto& item) {
            return std::strcmp(item.extensionName, XR_KHR_CONVERT_TIMESPEC_TIME_EXTENSION_NAME) == 0;
        });
        if (proProfile) extensions.push_back(XR_FB_TOUCH_CONTROLLER_PRO_EXTENSION_NAME);
        if (timeConversion) extensions.push_back(XR_KHR_CONVERT_TIMESPEC_TIME_EXTENSION_NAME);
        XrInstanceCreateInfoAndroidKHR androidInfo{XR_TYPE_INSTANCE_CREATE_INFO_ANDROID_KHR};
        androidInfo.applicationVM = app_->activity->vm;
        androidInfo.applicationActivity = app_->activity->clazz;
        XrInstanceCreateInfo createInfo{XR_TYPE_INSTANCE_CREATE_INFO};
        createInfo.next = &androidInfo;
        std::strcpy(createInfo.applicationInfo.applicationName, "Quest USB Forwarder");
        createInfo.applicationInfo.applicationVersion = 1;
        createInfo.applicationInfo.apiVersion = XR_MAKE_VERSION(1, 0, 34);
        createInfo.enabledExtensionCount = uint32_t(extensions.size());
        createInfo.enabledExtensionNames = extensions.data();
        check(xrCreateInstance(&createInfo, &instance_), "xrCreateInstance");
        if (timeConversion) toXrTime_ = function<PFN_xrConvertTimespecTimeToTimeKHR>("xrConvertTimespecTimeToTimeKHR");
        XrSystemGetInfo systemInfo{XR_TYPE_SYSTEM_GET_INFO};
        systemInfo.formFactor = XR_FORM_FACTOR_HEAD_MOUNTED_DISPLAY;
        check(xrGetSystem(instance_, &systemInfo, &system_), "xrGetSystem");
        XrGraphicsRequirementsOpenGLESKHR requirements{XR_TYPE_GRAPHICS_REQUIREMENTS_OPENGL_ES_KHR};
        check(function<PFN_xrGetOpenGLESGraphicsRequirementsKHR>("xrGetOpenGLESGraphicsRequirementsKHR")(instance_, system_, &requirements), "graphics requirements");
        initializeGraphics();
        XrGraphicsBindingOpenGLESAndroidKHR binding{XR_TYPE_GRAPHICS_BINDING_OPENGL_ES_ANDROID_KHR};
        binding.display = display_;
        binding.config = config_;
        binding.context = context_;
        XrSessionCreateInfo sessionInfo{XR_TYPE_SESSION_CREATE_INFO};
        sessionInfo.next = &binding;
        sessionInfo.systemId = system_;
        check(xrCreateSession(instance_, &sessionInfo, &session_), "xrCreateSession");
        XrReferenceSpaceCreateInfo spaceInfo{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
        spaceInfo.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_LOCAL;
        spaceInfo.poseInReferenceSpace.orientation.w = 1;
        check(xrCreateReferenceSpace(session_, &spaceInfo, &baseSpace_), "create LOCAL space");
        spaceInfo.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW;
        check(xrCreateReferenceSpace(session_, &spaceInfo, &viewSpace_), "create VIEW space");
        initializeActions(proProfile);
        initializeEyes();
        initialized_ = true;
        log("OpenXR ready; waiting for session focus");
    }
    void initializeGraphics() {
        display_ = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (display_ == EGL_NO_DISPLAY || !eglInitialize(display_, nullptr, nullptr)) throw std::runtime_error("eglInitialize failed");
        const EGLint attributes[]{EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
            EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_DEPTH_SIZE, 0, EGL_NONE};
        EGLint count = 0;
        if (!eglChooseConfig(display_, attributes, &config_, 1, &count) || count < 1) throw std::runtime_error("No GLES3 EGL config");
        const EGLint contextAttributes[]{EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
        context_ = eglCreateContext(display_, config_, EGL_NO_CONTEXT, contextAttributes);
        const EGLint surfaceAttributes[]{EGL_WIDTH, 16, EGL_HEIGHT, 16, EGL_NONE};
        surface_ = eglCreatePbufferSurface(display_, config_, surfaceAttributes);
        if (context_ == EGL_NO_CONTEXT || surface_ == EGL_NO_SURFACE || !eglMakeCurrent(display_, surface_, surface_, context_)) throw std::runtime_error("EGL context creation failed");
        glGenFramebuffers(1, &framebuffer_);
    }
    void initializeActions(bool proProfile) {
        hands_ = {path("/user/hand/left"), path("/user/hand/right")};
        XrActionSetCreateInfo info{XR_TYPE_ACTION_SET_CREATE_INFO};
        std::strcpy(info.actionSetName, "controller_input");
        std::strcpy(info.localizedActionSetName, "Controller Input");
        check(xrCreateActionSet(instance_, &info, &actionSet_), "create action set");
        pose_ = action("grip_pose", XR_ACTION_TYPE_POSE_INPUT);
        trigger_ = action("trigger", XR_ACTION_TYPE_FLOAT_INPUT);
        squeeze_ = action("squeeze", XR_ACTION_TYPE_FLOAT_INPUT);
        stick_ = action("thumbstick", XR_ACTION_TYPE_VECTOR2F_INPUT);
        stickClick_ = action("thumbstick_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
        stickTouch_ = action("thumbstick_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
        triggerTouch_ = action("trigger_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
        thumbrestTouch_ = action("thumbrest_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
        face1_ = action("face1_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
        face2_ = action("face2_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
        face1Touch_ = action("face1_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
        face2Touch_ = action("face2_touch", XR_ACTION_TYPE_BOOLEAN_INPUT);
        menu_ = action("menu_click", XR_ACTION_TYPE_BOOLEAN_INPUT);
        std::vector<XrActionSuggestedBinding> bindings;
        for (int hand = 0; hand < 2; ++hand) {
            const std::string prefix = hand == 0 ? "/user/hand/left/input/" : "/user/hand/right/input/";
            auto bind = [&](XrAction item, const char* suffix) { bindings.push_back({item, path((prefix + suffix).c_str())}); };
            bind(pose_, "grip/pose"); bind(trigger_, "trigger/value"); bind(squeeze_, "squeeze/value");
            bind(stick_, "thumbstick"); bind(stickClick_, "thumbstick/click"); bind(stickTouch_, "thumbstick/touch");
            bind(triggerTouch_, "trigger/touch"); bind(thumbrestTouch_, "thumbrest/touch");
            bind(face1_, hand == 0 ? "x/click" : "a/click"); bind(face2_, hand == 0 ? "y/click" : "b/click");
            bind(face1Touch_, hand == 0 ? "x/touch" : "a/touch"); bind(face2Touch_, hand == 0 ? "y/touch" : "b/touch");
            if (hand == 0) bind(menu_, "menu/click");
        }
        auto suggest = [&](const char* profile) {
            XrInteractionProfileSuggestedBinding suggestion{XR_TYPE_INTERACTION_PROFILE_SUGGESTED_BINDING};
            suggestion.interactionProfile = path(profile);
            suggestion.countSuggestedBindings = uint32_t(bindings.size());
            suggestion.suggestedBindings = bindings.data();
            check(xrSuggestInteractionProfileBindings(instance_, &suggestion), "suggest Touch bindings");
        };
        suggest("/interaction_profiles/oculus/touch_controller");
        if (proProfile) suggest("/interaction_profiles/facebook/touch_controller_pro");
        XrSessionActionSetsAttachInfo attach{XR_TYPE_SESSION_ACTION_SETS_ATTACH_INFO};
        attach.countActionSets = 1;
        attach.actionSets = &actionSet_;
        check(xrAttachSessionActionSets(session_, &attach), "attach actions");
        for (int hand = 0; hand < 2; ++hand) {
            XrActionSpaceCreateInfo space{XR_TYPE_ACTION_SPACE_CREATE_INFO};
            space.action = pose_; space.subactionPath = hands_[hand]; space.poseInActionSpace.orientation.w = 1;
            check(xrCreateActionSpace(session_, &space, &handSpaces_[hand]), "create hand space");
        }
    }
    void initializeEyes() {
        uint32_t count = 0;
        check(xrEnumerateViewConfigurationViews(instance_, system_, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, 0, &count, nullptr), "enumerate stereo views");
        if (count != 2) throw std::runtime_error("Expected exactly two stereo views");
        std::vector<XrViewConfigurationView> configs(count, {XR_TYPE_VIEW_CONFIGURATION_VIEW});
        check(xrEnumerateViewConfigurationViews(instance_, system_, XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO, count, &count, configs.data()), "enumerate stereo views");
        uint32_t formatCount = 0;
        check(xrEnumerateSwapchainFormats(session_, 0, &formatCount, nullptr), "enumerate formats");
        std::vector<int64_t> formats(formatCount);
        check(xrEnumerateSwapchainFormats(session_, formatCount, &formatCount, formats.data()), "enumerate formats");
        int64_t format = 0;
        for (int64_t candidate : {int64_t(GL_RGBA8), int64_t(GL_SRGB8_ALPHA8)})
            if (std::find(formats.begin(), formats.end(), candidate) != formats.end()) { format = candidate; break; }
        if (!format) throw std::runtime_error("No supported RGBA swapchain format");
        for (int eyeIndex = 0; eyeIndex < 2; ++eyeIndex) {
            Eye& eye = eyes_[eyeIndex];
            eye.width = int32_t(std::min(512u, configs[eyeIndex].recommendedImageRectWidth));
            eye.height = int32_t(std::min(512u, configs[eyeIndex].recommendedImageRectHeight));
            XrSwapchainCreateInfo info{XR_TYPE_SWAPCHAIN_CREATE_INFO};
            info.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
            info.format = format; info.sampleCount = 1; info.width = eye.width; info.height = eye.height;
            info.faceCount = 1; info.arraySize = 1; info.mipCount = 1;
            check(xrCreateSwapchain(session_, &info, &eye.swapchain), "create swapchain");
            uint32_t imageCount = 0;
            check(xrEnumerateSwapchainImages(eye.swapchain, 0, &imageCount, nullptr), "enumerate images");
            eye.images.resize(imageCount, {XR_TYPE_SWAPCHAIN_IMAGE_OPENGL_ES_KHR});
            check(xrEnumerateSwapchainImages(eye.swapchain, imageCount, &imageCount, reinterpret_cast<XrSwapchainImageBaseHeader*>(eye.images.data())), "enumerate images");
        }
    }
    void pollEvents() {
        XrEventDataBuffer event{XR_TYPE_EVENT_DATA_BUFFER};
        XrResult result;
        while ((result = xrPollEvent(instance_, &event)) == XR_SUCCESS) {
            if (event.type == XR_TYPE_EVENT_DATA_SESSION_STATE_CHANGED) {
                const auto& change = *reinterpret_cast<XrEventDataSessionStateChanged*>(&event);
                state_ = change.state;
                log(std::string("Session: ") + stateName(state_));
                if (state_ == XR_SESSION_STATE_READY) {
                    XrSessionBeginInfo begin{XR_TYPE_SESSION_BEGIN_INFO};
                    begin.primaryViewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
                    check(xrBeginSession(session_, &begin), "xrBeginSession"); running_ = true;
                } else if (state_ == XR_SESSION_STATE_STOPPING) {
                    check(xrEndSession(session_), "xrEndSession"); running_ = false;
                } else if (state_ == XR_SESSION_STATE_EXITING || state_ == XR_SESSION_STATE_LOSS_PENDING) exit_ = true;
            } else if (event.type == XR_TYPE_EVENT_DATA_INTERACTION_PROFILE_CHANGED) {
                for (int hand = 0; hand < 2; ++hand) {
                    XrInteractionProfileState profile{XR_TYPE_INTERACTION_PROFILE_STATE};
                    check(xrGetCurrentInteractionProfile(session_, hands_[hand], &profile), "get interaction profile");
                    if (profile.interactionProfile == XR_NULL_PATH) profiles_[hand] = "unavailable";
                    else {
                        uint32_t length = 0;
                        check(xrPathToString(instance_, profile.interactionProfile, 0, &length, nullptr), "profile path length");
                        std::vector<char> text(length);
                        check(xrPathToString(instance_, profile.interactionProfile, length, &length, text.data()), "profile path");
                        profiles_[hand] = text.data();
                    }
                    log(std::string(hand == 0 ? "Left profile: " : "Right profile: ") + profiles_[hand]);
                }
            } else if (event.type == XR_TYPE_EVENT_DATA_INSTANCE_LOSS_PENDING) exit_ = true;
            else if (event.type == XR_TYPE_EVENT_DATA_REFERENCE_SPACE_CHANGE_PENDING) ++referenceChanges_;
            event = {XR_TYPE_EVENT_DATA_BUFFER};
        }
        if (result != XR_EVENT_UNAVAILABLE) check(result, "xrPollEvent");
    }
    static void number(std::ostream& out, float value) {
        if (std::isfinite(value)) out << value;
        else out << "null";
    }
    static void vector(std::ostream& out, const XrVector3f& value) {
        out << '['; number(out, value.x); out << ','; number(out, value.y); out << ','; number(out, value.z); out << ']';
    }
    void boolean(std::ostream& out, XrAction item, int hand, bool active) {
        XrActionStateGetInfo info{XR_TYPE_ACTION_STATE_GET_INFO}; info.action = item; info.subactionPath = hands_[hand];
        XrActionStateBoolean state{XR_TYPE_ACTION_STATE_BOOLEAN};
        if (!active || XR_FAILED(xrGetActionStateBoolean(session_, &info, &state)) || !state.isActive) out << "null";
        else out << (state.currentState ? "true" : "false");
    }
    void scalar(std::ostream& out, XrAction item, int hand, bool active) {
        XrActionStateGetInfo info{XR_TYPE_ACTION_STATE_GET_INFO}; info.action = item; info.subactionPath = hands_[hand];
        XrActionStateFloat state{XR_TYPE_ACTION_STATE_FLOAT};
        if (!active || XR_FAILED(xrGetActionStateFloat(session_, &info, &state)) || !state.isActive) out << "null";
        else number(out, state.currentState);
    }
    void serializeHand(std::ostream& out, int hand, XrTime time, bool active) {
        Hand data;
        XrActionStateGetInfo info{XR_TYPE_ACTION_STATE_GET_INFO}; info.action = pose_; info.subactionPath = hands_[hand];
        XrActionStatePose poseState{XR_TYPE_ACTION_STATE_POSE};
        if (active && XR_SUCCEEDED(xrGetActionStatePose(session_, &info, &poseState)) && poseState.isActive) {
            data.poseActive = true;
            data.location.next = &data.velocity;
            if (XR_FAILED(xrLocateSpace(handSpaces_[hand], baseSpace_, time, &data.location))) {
                data.location.locationFlags = 0; data.velocity.velocityFlags = 0;
            }
        }
        const auto flags = data.location.locationFlags;
        const bool positionValid = flags & XR_SPACE_LOCATION_POSITION_VALID_BIT;
        const bool rotationValid = flags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT;
        out << "{\"interaction_profile\":" << quote(profiles_[hand]) << ",\"pose_active\":" << (data.poseActive ? "true" : "false")
            << ",\"position_valid\":" << (positionValid ? "true" : "false")
            << ",\"orientation_valid\":" << (rotationValid ? "true" : "false")
            << ",\"position_tracked\":" << ((flags & XR_SPACE_LOCATION_POSITION_TRACKED_BIT) ? "true" : "false")
            << ",\"orientation_tracked\":" << ((flags & XR_SPACE_LOCATION_ORIENTATION_TRACKED_BIT) ? "true" : "false")
            << ",\"position_m\":";
        if (positionValid) vector(out, data.location.pose.position); else out << "null";
        out << ",\"orientation_xyzw\":";
        if (rotationValid) {
            const auto& q = data.location.pose.orientation;
            out << '['; number(out, q.x); out << ','; number(out, q.y); out << ','; number(out, q.z); out << ','; number(out, q.w); out << ']';
        } else out << "null";
        out << ",\"linear_velocity_valid\":" << ((data.velocity.velocityFlags & XR_SPACE_VELOCITY_LINEAR_VALID_BIT) ? "true" : "false")
            << ",\"angular_velocity_valid\":" << ((data.velocity.velocityFlags & XR_SPACE_VELOCITY_ANGULAR_VALID_BIT) ? "true" : "false")
            << ",\"linear_velocity_m_s\":";
        if (data.velocity.velocityFlags & XR_SPACE_VELOCITY_LINEAR_VALID_BIT) vector(out, data.velocity.linearVelocity); else out << "null";
        out << ",\"angular_velocity_rad_s\":";
        if (data.velocity.velocityFlags & XR_SPACE_VELOCITY_ANGULAR_VALID_BIT) vector(out, data.velocity.angularVelocity); else out << "null";
        out << ",\"trigger\":"; scalar(out, trigger_, hand, active);
        out << ",\"squeeze\":"; scalar(out, squeeze_, hand, active);
        out << ",\"thumbstick\":";
        info.action = stick_;
        XrActionStateVector2f stickState{XR_TYPE_ACTION_STATE_VECTOR2F};
        if (active && XR_SUCCEEDED(xrGetActionStateVector2f(session_, &info, &stickState)) && stickState.isActive) {
            out << '['; number(out, stickState.currentState.x); out << ','; number(out, stickState.currentState.y); out << ']';
        } else out << "null";
        out << ",\"buttons\":{\"thumbstick_click\":"; boolean(out, stickClick_, hand, active);
        out << ",\"thumbstick_touch\":"; boolean(out, stickTouch_, hand, active);
        out << ",\"trigger_touch\":"; boolean(out, triggerTouch_, hand, active);
        out << ",\"thumbrest_touch\":"; boolean(out, thumbrestTouch_, hand, active);
        out << (hand == 0 ? ",\"x\":" : ",\"a\":"); boolean(out, face1_, hand, active);
        out << (hand == 0 ? ",\"y\":" : ",\"b\":"); boolean(out, face2_, hand, active);
        out << (hand == 0 ? ",\"x_touch\":" : ",\"a_touch\":"); boolean(out, face1Touch_, hand, active);
        out << (hand == 0 ? ",\"y_touch\":" : ",\"b_touch\":"); boolean(out, face2Touch_, hand, active);
        if (hand == 0) { out << ",\"menu\":"; boolean(out, menu_, hand, active); }
        out << "}}";
    }
    void frame() {
        XrFrameWaitInfo wait{XR_TYPE_FRAME_WAIT_INFO};
        XrFrameState frameState{XR_TYPE_FRAME_STATE};
        check(xrWaitFrame(session_, &wait, &frameState), "xrWaitFrame");
        XrFrameBeginInfo begin{XR_TYPE_FRAME_BEGIN_INFO};
        check(xrBeginFrame(session_, &begin), "xrBeginFrame");
        XrActiveActionSet activeSet{actionSet_, XR_NULL_PATH};
        XrActionsSyncInfo sync{XR_TYPE_ACTIONS_SYNC_INFO}; sync.countActiveActionSets = 1; sync.activeActionSets = &activeSet;
        const XrResult syncResult = xrSyncActions(session_, &sync);
        const bool active = state_ == XR_SESSION_STATE_FOCUSED && resumed_ && syncResult == XR_SUCCESS;
        if (XR_FAILED(syncResult)) log("xrSyncActions: " + std::to_string(syncResult));
        XrTime sampleTime = frameState.predictedDisplayTime;
        const char* timeSource = "predicted_display_time";
        timespec now{};
        XrTime currentTime = 0;
        if (toXrTime_ && clock_gettime(CLOCK_MONOTONIC, &now) == 0 && XR_SUCCEEDED(toXrTime_(instance_, &now, &currentTime))) {
            sampleTime = currentTime;
            timeSource = "monotonic_now";
        }
        XrSpaceLocation headLocation{XR_TYPE_SPACE_LOCATION};
        if (XR_FAILED(xrLocateSpace(viewSpace_, baseSpace_, sampleTime, &headLocation))) headLocation.locationFlags = 0;
        const auto headFlags = headLocation.locationFlags;
        std::ostringstream out;
        out.imbue(std::locale::classic()); out << std::setprecision(7);
        out << "{\"schema\":\"quest-usb-v1\",\"kind\":\"frame\",\"sequence\":" << ++sequence_
            << ",\"device_monotonic_ns\":\"" << monotonicNs() << "\",\"xr_time_ns\":\"" << sampleTime
            << "\",\"sample_time_source\":" << quote(timeSource) << ",\"reference_space\":\"local\",\"reference_space_changes\":" << referenceChanges_
            << ",\"session_state\":" << quote(stateName(state_)) << ",\"focused\":" << (active ? "true" : "false")
            << ",\"android_resumed\":" << (resumed_ ? "true" : "false") << ",\"xr_running\":" << (running_ ? "true" : "false")
            << ",\"head_tracking\":{\"position_valid\":" << ((headFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT) ? "true" : "false")
            << ",\"position_tracked\":" << ((headFlags & XR_SPACE_LOCATION_POSITION_TRACKED_BIT) ? "true" : "false")
            << ",\"orientation_valid\":" << ((headFlags & XR_SPACE_LOCATION_ORIENTATION_VALID_BIT) ? "true" : "false")
            << ",\"orientation_tracked\":" << ((headFlags & XR_SPACE_LOCATION_ORIENTATION_TRACKED_BIT) ? "true" : "false") << '}'
            << ",\"left\":";
        serializeHand(out, 0, sampleTime, active);
        out << ",\"right\":"; serializeHand(out, 1, sampleTime, active); out << '}';
        sender_.publish(out.str());

        std::array<XrView, 2> views{{{XR_TYPE_VIEW}, {XR_TYPE_VIEW}}};
        std::array<XrCompositionLayerProjectionView, 2> projectionViews{{{XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW}, {XR_TYPE_COMPOSITION_LAYER_PROJECTION_VIEW}}};
        XrCompositionLayerProjection layer{XR_TYPE_COMPOSITION_LAYER_PROJECTION}; layer.space = baseSpace_;
        bool rendered = false;
        if (frameState.shouldRender) {
            XrViewLocateInfo locate{XR_TYPE_VIEW_LOCATE_INFO}; locate.viewConfigurationType = XR_VIEW_CONFIGURATION_TYPE_PRIMARY_STEREO;
            locate.displayTime = frameState.predictedDisplayTime; locate.space = baseSpace_;
            XrViewState viewState{XR_TYPE_VIEW_STATE}; uint32_t viewCount = 0;
            check(xrLocateViews(session_, &locate, &viewState, 2, &viewCount, views.data()), "xrLocateViews");
            const auto required = XR_VIEW_STATE_ORIENTATION_VALID_BIT | XR_VIEW_STATE_POSITION_VALID_BIT;
            if (viewCount == 2 && (viewState.viewStateFlags & required) == required) {
                for (int eyeIndex = 0; eyeIndex < 2; ++eyeIndex) {
                    Eye& eye = eyes_[eyeIndex]; uint32_t image = 0;
                    XrSwapchainImageAcquireInfo acquire{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
                    check(xrAcquireSwapchainImage(eye.swapchain, &acquire, &image), "acquire image");
                    XrSwapchainImageWaitInfo imageWait{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO}; imageWait.timeout = XR_INFINITE_DURATION;
                    check(xrWaitSwapchainImage(eye.swapchain, &imageWait), "wait image");
                    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer_);
                    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, eye.images[image].image, 0);
                    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) throw std::runtime_error("Incomplete eye framebuffer");
                    glViewport(0, 0, eye.width, eye.height); glDisable(GL_SCISSOR_TEST); glClearColor(0, 0, 0, 1); glClear(GL_COLOR_BUFFER_BIT);
                    glBindFramebuffer(GL_FRAMEBUFFER, 0); glFlush();
                    XrSwapchainImageReleaseInfo release{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
                    check(xrReleaseSwapchainImage(eye.swapchain, &release), "release image");
                    projectionViews[eyeIndex].pose = views[eyeIndex].pose; projectionViews[eyeIndex].fov = views[eyeIndex].fov;
                    projectionViews[eyeIndex].subImage.swapchain = eye.swapchain;
                    projectionViews[eyeIndex].subImage.imageRect.extent = {eye.width, eye.height};
                }
                layer.viewCount = 2; layer.views = projectionViews.data(); rendered = true;
            }
        }
        const XrCompositionLayerBaseHeader* header = reinterpret_cast<const XrCompositionLayerBaseHeader*>(&layer);
        XrFrameEndInfo end{XR_TYPE_FRAME_END_INFO}; end.displayTime = frameState.predictedDisplayTime;
        end.environmentBlendMode = XR_ENVIRONMENT_BLEND_MODE_OPAQUE;
        end.layerCount = rendered ? 1 : 0; end.layers = rendered ? &header : nullptr;
        check(xrEndFrame(session_, &end), "xrEndFrame");
    }
    void status(const char* state, const std::string& message = "") {
        sender_.publish("{\"schema\":\"quest-usb-v1\",\"kind\":\"status\",\"sequence\":" + std::to_string(++sequence_) +
            ",\"device_monotonic_ns\":\"" + std::to_string(monotonicNs()) + "\",\"state\":" + quote(state) + ",\"message\":" + quote(message) +
            ",\"android_resumed\":" + (resumed_ ? "true" : "false") + ",\"xr_running\":" + (running_ ? "true" : "false") + "}");
    }
    void cleanup() {
        for (auto& eye : eyes_) if (eye.swapchain) xrDestroySwapchain(eye.swapchain);
        for (auto space : handSpaces_) if (space) xrDestroySpace(space);
        if (viewSpace_) xrDestroySpace(viewSpace_);
        if (baseSpace_) xrDestroySpace(baseSpace_);
        if (session_) xrDestroySession(session_);
        if (actionSet_) xrDestroyActionSet(actionSet_);
        if (instance_) xrDestroyInstance(instance_);
        if (framebuffer_) glDeleteFramebuffers(1, &framebuffer_);
        if (display_ != EGL_NO_DISPLAY) {
            eglMakeCurrent(display_, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if (surface_ != EGL_NO_SURFACE) eglDestroySurface(display_, surface_);
            if (context_ != EGL_NO_CONTEXT) eglDestroyContext(display_, context_);
            eglTerminate(display_);
        }
    }
    android_app* app_;
    Sender sender_;
    bool resumed_ = false, initialized_ = false, running_ = false, exit_ = false;
    XrInstance instance_ = XR_NULL_HANDLE;
    XrSystemId system_ = XR_NULL_SYSTEM_ID;
    XrSession session_ = XR_NULL_HANDLE;
    XrSessionState state_ = XR_SESSION_STATE_UNKNOWN;
    XrSpace baseSpace_ = XR_NULL_HANDLE;
    XrSpace viewSpace_ = XR_NULL_HANDLE;
    PFN_xrConvertTimespecTimeToTimeKHR toXrTime_ = nullptr;
    XrActionSet actionSet_ = XR_NULL_HANDLE;
    std::array<XrPath, 2> hands_{};
    std::array<XrSpace, 2> handSpaces_{};
    std::array<std::string, 2> profiles_{{"unavailable", "unavailable"}};
    XrAction pose_{}, trigger_{}, squeeze_{}, stick_{}, stickClick_{}, stickTouch_{}, triggerTouch_{}, thumbrestTouch_{}, face1_{}, face2_{}, face1Touch_{}, face2Touch_{}, menu_{};
    std::array<Eye, 2> eyes_;
    EGLDisplay display_ = EGL_NO_DISPLAY;
    EGLConfig config_ = nullptr;
    EGLContext context_ = EGL_NO_CONTEXT;
    EGLSurface surface_ = EGL_NO_SURFACE;
    GLuint framebuffer_ = 0;
    uint64_t sequence_ = 0, referenceChanges_ = 0;
    int64_t lastHeartbeat_ = 0;
};
} // namespace

extern "C" void android_main(android_app* app) {
    JNIEnv* env = nullptr;
    if (app->activity->vm->AttachCurrentThread(&env, nullptr) != JNI_OK) {
        log("ERROR: cannot attach XR thread to Java VM"); ANativeActivity_finish(app->activity); return;
    }
    ANativeActivity_setWindowFlags(app->activity, AWINDOW_FLAG_KEEP_SCREEN_ON | AWINDOW_FLAG_FULLSCREEN, 0);
    {
        Forwarder forwarder(app);
        app->userData = &forwarder;
        app->onAppCmd = [](android_app* state, int32_t command) { static_cast<Forwarder*>(state->userData)->onCommand(command); };
        try { forwarder.run(); }
        catch (const std::exception& error) { forwarder.error(error.what()); ANativeActivity_finish(app->activity); }
        app->userData = nullptr;
        app->onAppCmd = nullptr;
    }
    app->activity->vm->DetachCurrentThread();
}
