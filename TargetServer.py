import http.server
import socketserver
import os
import functools # 需要导入 functools 模块

# 定义服务器监听的端口号
PORT = 6688
# 定义要服务的相对目录名
TARGET_SUBDIR = "TargetDomain"

# --- 确定要服务的目录 ---
# 获取脚本文件所在的目录
# __file__ 是当前脚本的文件名。os.path.dirname 获取其目录。
# 如果直接在交互式解释器中运行，__file__ 可能未定义，此时回退到当前工作目录
try:
    script_directory = os.path.dirname(os.path.abspath(__file__))
except NameError:
    script_directory = os.getcwd()

# 构造目标服务目录的绝对路径
serve_directory = os.path.join(script_directory, TARGET_SUBDIR)
serve_directory = os.path.abspath(serve_directory) # 转换为绝对路径更清晰

# --- 检查目标目录是否存在 ---
if not os.path.isdir(serve_directory):
    print(f"错误：指定的服务器根目录 '{serve_directory}' 不存在。")
    print(f"请确保在脚本所在目录下有一个名为 '{TARGET_SUBDIR}' 的文件夹。")
    exit(1) # 如果目录不存在，则退出脚本

# --- 配置请求处理器 ---
# 使用 functools.partial 创建一个新的处理器类
# 这个新类在实例化时会自动将 serve_directory 作为 directory 参数传递给 SimpleHTTPRequestHandler
# 这是因为 TCPServer 会在处理每个请求时创建 Handler 的实例，我们无法直接传递参数
# functools.partial(func, *args, **keywords) 会返回一个类似函数的新对象，
# 调用它时会像调用 func 一样，但会自动传入预设的 args 和 keywords。
Handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                            directory=serve_directory)
# 文档参考: https://docs.python.org/zh-cn/3/library/functools.html#functools.partial
# 文档参考: https://docs.python.org/zh-cn/3/library/http.server.html#http.server.SimpleHTTPRequestHandler (查看 directory 参数，3.7新增)

# --- 启动服务器 ---
try:
    # 使用 socketserver.TCPServer 创建一个 TCP 服务器实例
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"成功启动 HTTP 服务器，正在监听端口 {PORT}")
        # 明确告知用户服务的是哪个目录
        print(f"服务目录: {serve_directory}")
        print(f"请在浏览器中访问: http://localhost:{PORT} 或 http://<你的IP地址>:{PORT}")

        # 让服务器一直运行，直到被中断 (例如按下 Ctrl+C)
        httpd.serve_forever()

except OSError as e:
    # 处理端口已被占用的情况
    if e.errno == 98 or e.errno == 48: # errno 98 (Linux) or 48 (macOS/Windows) for Address already in use
        print(f"错误：端口 {PORT} 已被占用。")
        print("请尝试使用其他端口运行脚本，或者关闭占用该端口的程序。")
    else:
        print(f"启动服务器时发生错误: {e}")
except KeyboardInterrupt:
    # 处理用户手动中断 (Ctrl+C)
    print("\n收到中断信号，正在关闭服务器...")
finally:
    print("服务器已成功关闭。")
