class Spike < Formula
  desc "Always-on iMessage agent backed by Codex app-server"
  homepage "https://github.com/seanmozeik/spike"
  url "https://github.com/seanmozeik/spike/releases/download/v0.0.1/spike-0.0.1.tar.gz"
  version "0.0.1"
  sha256 "3e1cec53310029051344aee6d3fb5cba45600f90dd3a9ee5e4816878c4fd5fc8"
  license "MIT"

  depends_on arch: :arm64
  depends_on macos: :tahoe
  depends_on "oven-sh/bun/bun"

  def install
    libexec.install Dir["*"]
    (bin/"spike").write <<~EOS
      #!/bin/bash
      exec "#{formula_opt_bin("bun")}/bun" "#{libexec}/dist/spike" "$@"
    EOS
  end

  test do
    assert_match "spike", shell_output("#{bin}/spike --help")
  end
end
