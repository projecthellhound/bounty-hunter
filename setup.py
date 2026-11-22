from setuptools import setup, find_packages

setup(
    name="hellhound",
    version="12.7.0",
    description="HELLHOUND — Autonomous AI Bug Bounty Reconnaissance & Triage Framework",
    packages=find_packages(),
    include_package_data=True,
    install_requires=[
        "aiohttp",
        "beautifulsoup4",
        "click",
        "colorama",
        "cryptography",
        "lxml",
        "playwright==1.56.0",
        "pyyaml",
        "requests",
        "rich",
        "prompt_toolkit",
        "textual>=0.80",
    ],
    extras_require={
        # `pip install hellhound[gui]` pulls the browser-GUI backend deps.
        # The GUI (beast_gui/) is an alternate front-end over the SAME agent;
        # without this extra, `beast` (TUI) and `beast --classic` still work.
        "gui": [
            "fastapi>=0.110",
            "uvicorn>=0.27",
            "websockets>=12",
            # Native desktop-app window (`beast --gui`). On Linux it uses the
            # system WebKit2GTK backend; falls back to a browser tab if no
            # webview backend is present (headless/SSH).
            "pywebview>=5",
        ],
    },
    entry_points={
        "console_scripts": [
            # `beast` is the primary command (the tool's nickname); `hellhound`
            # stays as a back-compat alias. Both point to hellhound/cli.py → main().
            "beast = hellhound.cli:main",
            "hellhound = hellhound.cli:main",
        ]
    },
    python_requires=">=3.10",
)