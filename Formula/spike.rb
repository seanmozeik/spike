class Spike < Formula
  desc "Always-on iMessage agent backed by Codex app-server"
  homepage "https://github.com/seanmozeik/spike"
  version "0.0.1"
  license "MIT"

  url "https://github.com/seanmozeik/spike/releases/download/v#{version}/spike-#{version}.tar.gz"
  sha256 "89f2398bfd079eddf6e0baf368175cc51298e2444b341587ba8d71d0810fc741"

  depends_on "oven-sh/bun/bun"

  def install
    libexec.install Dir["*"]
    (bin/"spike").write <<~EOS
      #!/bin/bash
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/dist/spike" "$@"
    EOS
  end

  test do
    assert_match "spike", shell_output("#{bin}/spike --help")
  end
end
